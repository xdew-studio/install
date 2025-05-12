/**
 * Task to install cert-manager on Kubernetes
 */
const fs = require('fs/promises');
const kubernetesController = require('../controllers/kubernetes');
const logger = require('../utils/logger');

/**
 * Main task function for cert-manager installation
 * @param {Object} config - Configuration object
 * @returns {Promise<Object>} - Created resources
 */
const run = async (config) => {
	try {
		logger.start('Installing cert-manager on Kubernetes');

		await kubernetesController.initialize(config.kubernetes.kubeconfigPath);

		const values = [
			{
				name: '__NAMESPACE__',
				value: config.kubernetes.monitoring.namespace,
			},
		];

		await kubernetesController.deployHelm(
			'jetstack/cert-manager',
			'cert-manager',
			config.kubernetes.operator,
			{
				name: 'jetstack',
				url: 'https://charts.jetstack.io',
			},
			'files/cert-manager.yaml',
			values
		);

		try {
			const existingIssuer = await kubernetesController._k8sCustomApi.getClusterCustomObject({
				group: 'cert-manager.io',
				version: 'v1',
				plural: 'clusterissuers',
				name: config.general.name + '-issuer',
			});
			if (existingIssuer) {
				logger.success(`ClusterIssuer ${config.general.name}-issuer already exists`);
				return;
			}
		} catch (error) {
			if (error.response && error.response.statusCode !== 404) {
				throw error;
			}
		}

		await kubernetesController._k8sCustomApi.createClusterCustomObject({
			group: 'cert-manager.io',
			version: 'v1',
			plural: 'clusterissuers',
			body: {
				apiVersion: 'cert-manager.io/v1',
				kind: 'ClusterIssuer',
				metadata: {
					name: config.general.name + '-issuer',
				},
				spec: {
					acme: {
						email: config.general.email,
						server: 'https://acme-v02.api.letsencrypt.org/directory',
						privateKeySecretRef: {
							name: config.general.name + '-issuer-key',
						},
						solvers: [
							{
								http01: {
									ingress: {
										class: 'nginx',
									},
								},
							},
						],
					},
				},
			},
		});

		logger.success(`cert-manager installed successfully`);
		return;
	} catch (error) {
		logger.error(`Failed to install cert-manager: ${error.message}`);
		throw error;
	}
};

module.exports = {
	run,
};
