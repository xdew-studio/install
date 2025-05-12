/**
 * Task to install Democratic-csi on Kubernetes
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
		logger.start('Installing Democratic-csi on Kubernetes');

		await kubernetesController.initialize(config.kubernetes.kubeconfigPath);

		const privateKey = await fs.readFile(config.storage.private_key, 'utf8');

		const values = [
			{
				name: '__STORAGE_CLASS_NAME__',
				value: config.general.name + '-storage',
			},
			{
				name: '__DOMAIN__',
				value: 'storage.' + config.general.domain,
			},
			{
				name: '__API_KEY__',
				value: config.storage.api_key,
			},
			{
				name: '__PRIVATE_KEY__',
				value: privateKey,
			},
			{
				name: '__DATASET_NAME__',
				value: config.general.name,
			},
		];

		await kubernetesController.deployHelm(
			'democratic-csi/democratic-csi',
			'democratic-csi',
			config.kubernetes.operator,
			{
				name: 'democratic-csi',
				url: 'https://democratic-csi.github.io/charts/',
			},
			'files/democratic-csi.yaml',
			values
		);

		logger.success(`Democratic-csi installed successfully`);
		return;
	} catch (error) {
		logger.error(`Failed to install Democratic-csi: ${error.message}`);
		throw error;
	}
};

module.exports = {
	run,
};
