/**
 * Task to create a Kubernetes cluster in Rancher
 */
const rancherController = require('../controllers/rancher');
const { updateConfig } = require('../utils/config');
const logger = require('../utils/logger');
const fs = require('fs').promises;
const path = require('path');

/**
 * Main task function
 * @param {Object} config - Configuration object
 * @returns {Promise<Object>} - Created Kubernetes cluster and registration info
 */
const run = async (config) => {
	try {
		logger.start('Creating Kubernetes cluster in Rancher');

		await rancherController.authenticate({
			domain: config.rancher.domain,
			username: config.rancher.username || 'cli',
			password: config.rancher.password || config.rancher.cli_password,
		});

		const clusterConfig = {
			name: config.general.name,
			version: config.kubernetes.version,
			machinePools: config.kubernetes.machinePools || [],
		};

		const cluster = await rancherController.createCluster(clusterConfig);
		logger.success(`Created Kubernetes cluster: ${cluster.name} (ID: ${cluster.id})`);

		await updateConfig('kubernetes.clusterId', cluster.id);
		await updateConfig('kubernetes.v1Id', cluster.v1Id);
		await updateConfig('kubernetes.v3Id', cluster.v3Id);

		logger.info('Generating registration token for cluster nodes');
		const registrationToken = await rancherController.getRegistrationToken(cluster.id);

		await updateConfig('kubernetes.token', registrationToken.token);

		logger.info('Waiting for cluster to become ready...');
		const readyCluster = await rancherController.waitForClusterReady(cluster.id);

		logger.info('Generating kubeconfig for the cluster');
		const kubeconfig = await rancherController.getKubeConfig(cluster.id);

		const kubeconfigPath = path.join(process.cwd(), 'data', `${cluster.name}-kubeconfig.yaml`);
		await fs.writeFile(kubeconfigPath, kubeconfig, 'utf8');
		logger.success(`Kubeconfig written to ${kubeconfigPath}`);

		const output = {
			cluster: readyCluster,
			registrationToken,
			registrationCommand: registrationToken.nodeCommand,
			kubeconfigPath,
			commandFilePath,
		};

		logger.success('Kubernetes cluster creation completed successfully');
		return output;
	} catch (error) {
		logger.error(`Failed to create Kubernetes cluster: ${error.message}`);
		throw error;
	}
};

module.exports = {
	run,
};
