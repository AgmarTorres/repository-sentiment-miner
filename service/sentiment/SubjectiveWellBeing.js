const Promise = require('bluebird');
const models = require("../../model/mongo/index.js");
const moment = require("moment");
const util = require("../../lib/util.js");
const Pull = models.Pull;
const Commits = models.Commit;
const PullReviews = models.PullReviews;
const PullComments = models.PullComments;
const Developer = models.Developer;
const _ = require("lodash");
const sentimentProperty = "sentistrength_new.wholeText.whole_text.scale";
const devQuery = dev => {
    return {
        $or: [{
            "user.login": dev.value.login
        }, {
            "author.login": dev.value.login
        }]
    };
};

const saveDeveloper = (dev) => {
    return new Promise((resolve, reject) => Developer.collection.update({
        "value.login": dev.value.login
    }, {
        $set: dev
    }, (e) => {
        if (e) return reject(e);
        else resolve(true);
    })).then(console.log);
};
const setProcessing = (dev) => {
    return new Promise((resolve, reject) => Developer.collection.update({
        "value.login": dev.value.login
    }, {
        $set: {
            swbProcessing: true
        }
    }, (e, r) => {
        if (e) return reject(e);
        else resolve(r.result.nModified > 0);
    }));
};

function subjectiveWellbeen(sentiments) {
    const swb = {
        negative: 0,
        positive: 0,
        zero: 0
    };
    sentiments.forEach(s => {
        const scale = _.get(s, 'sentistrength_new.wholeText.whole_text.scale', 0);
        if (scale < 0) {
            swb.negative++;
        } else if (scale > 0) {
            swb.positive++;
        } else {
            swb.zero++;
        }
    });
    swb.sentiment = (swb.positive - swb.negative) / (swb.positive + swb.negative);
    if (_.isNaN(swb.sentiment)) {
        swb.sentiment = 0;
    }
    return swb;
}
const FILTER_QUERY = {
    /*    swb: {
            $exists: false
        },
        */
    swbProcessing: {
        $exists: false
    }
};
async function processNext(filter = {}, hour = 2) {
    return Developer.findOne(FILTER_QUERY)
        .sort({
            _id: 'asc'
        })
        .lean()
        .then((dev) => {
            dev.swbProcessing = true;
            return setProcessing(dev).then(updated => {
                return {
                    updated,
                    dev
                };
            });
        }).then(async (result) => {
            if (!result.updated) {
                console.log(`Will not update anyting, going to the next`);
                return;
            }
            const dev = result.dev;
            console.log('processing:', dev.value.login);
            console.log('got the pulls:', dev.value.login);
            const pulls = await Pull.find(devQuery(dev));
            console.log('got the comments:', dev.value.login);
            const commentsOnItsPrs = await PullComments.find({
                "user.login": {
                    $ne: dev.value.login
                },
                _pull: {
                    $in: pulls.map(a => a._id)
                }
            }).lean();
            console.log('will get the relation:', dev.value.login);
            const commentQuery = devQuery(dev);
            return Promise.map(commentsOnItsPrs, (comment => {
                const beforeFilter = {
                    $gte: moment(comment.created_at).subtract(hour, 'hours').toDate(),
                    $lt: moment(comment.created_at).toDate()
                };

                const afterFilter = {
                    $gt: moment(comment.created_at).toDate(),
                    $lte: moment(comment.created_at).add(hour, 'hours').toDate()
                };

                const beforeQuery = Object.assign({
                    "created_at": beforeFilter
                }, commentQuery);

                const afterQuery = Object.assign({
                    "created_at": afterFilter
                }, commentQuery);
                const pcb = PullComments.find(beforeQuery).lean().exec();
                const pcmb = Commits.find(Object.assign({
                    "commiter.date": beforeFilter,
                    "sentistrength_new.wholeText.whole_text.scale": {
                        $exists: true
                    }
                }, devQuery)).lean().exec();
                const pca = PullComments.find(afterQuery).lean().exec();
                const pcma = Commits.find(Object.assign({
                    "commiter.date": afterFilter,
                    "sentistrength_new.wholeText.whole_text.scale": {
                        $exists: true
                    }
                }, devQuery)).lean().exec();
                return Promise.all([pcb, pcmb, pca, pcma]).spread((beforeComments, beforeCommits, afterComments, afterCommits) => {
                    const swbBeforeCommits = subjectiveWellbeen(beforeCommits || []);
                    const swbBeforeComments = subjectiveWellbeen(beforeComments || []);
                    const swbAfterCommits = subjectiveWellbeen(afterCommits || []);
                    const swbAfterComments = subjectiveWellbeen(afterComments || []);
                    dev.swb = dev.swb || {};
                    const hourSwb = dev.swb[hour] = dev.swb[hour] || {};
                    const projectSwb = hourSwb[comment._project.toString()] = hourSwb[comment._project.toString()] || {};
                    projectSwb[comment.author_association] = projectSwb[comment.author_association] || [];
                    const swb = projectSwb[comment.author_association];
                    console.log(`swb processd for ${comment.author_association}  in ${comment._project.toString()},  ${swb.length}`)
                    swb.push({
                        commentSentiment: _.get(comment, 'sentistrength_new.wholeText.whole_text.scale'),
                        swbBeforeCommits,
                        swbAfterCommits,
                        result: swbAfterCommits.sentiment - swbBeforeCommits.sentiment,
                        entity: 'commit'
                    });

                    swb.push({
                        commentSentiment: _.get(comment, 'sentistrength_new.wholeText.whole_text.scale'),
                        swbBeforeComments,
                        swbAfterComments,
                        result: swbAfterComments.sentiment - swbBeforeComments.sentiment,
                        entity: 'comment'
                    });

                });
            })).then(() => {
                dev.swbProcessing = false;
                dev.swb = dev.swb || {};
                dev.swb[hour] = dev.swb[hour] || {};
                const swbHour = dev.swb[hour];
                const swbs = Object.keys(swbHour || {})
                    .map(key => {
                        const swb = swbHour[key];
                        return Object.keys(swb).map((rule) => swb[rule]).reduce((current, actual) => {
                            return current.concat(actual);
                        }, []);
                    }).reduce((current, actual) => current.concat(actual), []);
                const sum = sumResults(swbs);
                const avg = sum / swbs.length;
                const swbFromNegative = swbs.filter(swb => swb.commentSentiment < 0);
                const swbFromPositive = swbs.filter(swb => swb.commentSentiment > 0);
                const sumNegative = sumResults(swbFromNegative);
                const sumPositive = sumResults(swbFromPositive);
                swbHour.swbGeneral = {
                    count: swbs.length,
                    sum,
                    avg
                };

                swbHour.swbNegative = {
                    count: swbFromNegative.length,
                    sum: sumNegative,
                    avg: sumNegative / swbFromNegative.length
                };

                swbHour.swbPositive = {
                    count: swbFromPositive.length,
                    sum: sumPositive,
                    avg: sumPositive / swbFromPositive.length
                };
                return saveDeveloper(dev);
            });
        }).then(function() {
            return Developer.count(FILTER_QUERY);
        }).then((developers) => {
            if (developers != 0) {
                return processNext(filter, hour);
            }
        }).then(() => {
            console.log("SWB Success \o/");
        }).catch((e) => {
            console.error("SWB Error :(", e)
        });
}

function sumResults(swbs) {
    const results = swbs.map(r => r.result).filter(v => !isNaN(v));
    return results.reduce((a, b) => a + b, 0);
}

module.exports.processSWB = function(filter = {}, hour = 2) {
    return Developer.update(_.omit(FILTER_QUERY, ['swbProcessing']), {
        $unset: {
            swbProcessing: true
        }
    }, {
        multi: true
    }).then((a) => {
        return processNext(filter, hour);
    });
}
