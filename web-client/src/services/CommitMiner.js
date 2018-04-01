import axios from 'axios';

class CommitMiner {
  constructor(domain) {
    this.domain = domain;
  }

  getConfiguration() {
    return axios.get(`http://${this.domain}:8081/config`);
  }

  updateConfig(config) {
    return axios.post(`http://${this.domain}:8081/config`, config);
  }

  startProject(url) {
    return axios.post(`http://${this.domain}:8081/start`, {
      url: url
    });
  }

  getProjectState(projectName) {
    return axios.get(`http://${this.domain}:8081/project/${projectName}`);
  }

  getProjectList() {
    return axios.get(`http://${this.domain}:8081/list`);
  }

  getProjectStatus(project) {
    return axios.get(
      `http://${this.domain}:8081/project/status/${project.name}`
    );
  }

  getInteractionsReport(project) {
    return axios.get(`http://${this.domain}:8081/reports/sentimentByType`);
  }

  getWeekDayeReport(project) {
    return axios.get(`http://${this.domain}:8081/reports/weekday`);
  }
}
export default CommitMiner;