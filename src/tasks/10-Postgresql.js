/**
 * Task to install PostgreSQL on Kubernetes
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
		logger.start('Installing PostgreSQL on Kubernetes');

		await kubernetesController.initialize(config.kubernetes.kubeconfigPath);
		await kubernetesController.deployHelm('cnpg/cloudnative-pg', 'cnpg-operator', config.kubernetes.operator, {
			name: 'cnpg',
			url: 'https://cloudnative-pg.github.io/charts',
		});

		try {
			const existingCluster = await kubernetesController._k8sCustomApi.getNamespacedCustomObject({
				group: 'postgresql.cnpg.io',
				version: 'v1',
				plural: 'clusters',
				name: 'system-cluster',
				namespace: config.kubernetes.system.namespace,
			});
			if (existingCluster) {
				logger.success(`Cluster already exists`);
				return;
			}
		} catch (error) {
			if (error.response && error.response.statusCode !== 404) {
				throw error;
			}
		}

		await kubernetesController._k8sCustomApi.createNamespacedCustomObject({
			group: 'postgresql.cnpg.io',
			version: 'v1',
			plural: 'clusters',
			namespace: config.kubernetes.system.namespace,
			body: {
				apiVersion: 'postgresql.cnpg.io/v1',
				kind: 'Cluster',
				metadata: {
					name: 'system-cluster',
					namespace: config.kubernetes.system.namespace,
				},
				spec: {
					instances: 2,
					monitoring: {
						enablePodMonitor: true,
					},
					storage: {
						size: '5Gi',
						storageClass: config.storage.storage_class,
					},
					managed: {
						roles: [
							{
								name: 'keycloak-user',
								ensure: 'present',
								login: true,
								superuser: false,
								passwordSecret: {
									name: 'keycloak-db-credential',
								},
							},
							{
								name: 'outline-user',
								ensure: 'present',
								login: true,
								superuser: false,
								passwordSecret: {
									name: 'outline-db-credential',
								},
							},
						],
					},
				},
			},
		});

		logger.success(`PostgreSQL Cloud native operator installed successfully`);
		return;
	} catch (error) {
		logger.error(`Failed to install PostgreSQL: ${error.message}`);
		throw error;
	}
};

module.exports = {
	run,
};
