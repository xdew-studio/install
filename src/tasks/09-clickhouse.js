/**
 * Task to install Clickhouse on Kubernetes
 */
const fs = require('fs/promises');
const kubernetesController = require('../controllers/kubernetes');
const logger = require('../utils/logger');

/**
 * Main task function
 * @param {Object} config - Configuration object
 * @returns {Promise<Object>} - Created resources
 */
const run = async (config) => {
	try {
		logger.start('Installing Clickhouse on Kubernetes');

		await kubernetesController.initialize(config.kubernetes.kubeconfigPath);

		await kubernetesController.deployHelm('altinity-clickhouse-operator/altinity-clickhouse-operator', 'clickhouse-operator', config.kubernetes.operator, {
			name: 'altinity-clickhouse-operator',
			url: 'https://docs.altinity.com/clickhouse-operator/',
		});

		logger.success(`Clickhouse installed successfully`);
		return;
	} catch (error) {
		logger.error(`Failed to install Clickhouse: ${error.message}`);
		throw error;
	}
};

module.exports = {
	run,
};
