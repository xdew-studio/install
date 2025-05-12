/**
 * Kubernetes controller
 * Provides simplified methods to manage Kubernetes resources
 */
const fs = require('fs').promises;
const logger = require('../utils/logger');
const { exec } = require('child_process');
const util = require('util');
const axios = require('axios');
const yaml = require('js-yaml');
const https = require('https');
const execPromise = util.promisify(exec);

const axiosClient = axios.create({
	timeout: 30000,
	httpsAgent: new https.Agent({
		rejectUnauthorized: false,
	}),
});

class KubernetesController {
	constructor() {
		this._kubeConfig = null;
		this._k8sCoreApi = null;
		this._k8sAppsApi = null;
		this._k8sNetworkingApi = null;
		this._k8sCustomApi = null;
		this._k8sModule = null;
		this._k8sBatchApi = null;
		this._kubeConfigPath = null;
	}

	/**
	 * Initialize the controller with a kubeconfig file
	 * @param {String} kubeconfigPath - Path to the kubeconfig file
	 * @returns {Promise<KubernetesController>} This instance for chaining
	 */
	async initialize(kubeconfigPath) {
		try {
			logger.info(`Initializing Kubernetes controller with kubeconfig: ${kubeconfigPath}`);

			this._k8sModule = await import('@kubernetes/client-node');
			this._kubeConfigPath = kubeconfigPath;
			const k8s = this._k8sModule;

			this._kubeConfig = new k8s.KubeConfig();
			this._kubeConfig.loadFromFile(kubeconfigPath);
			this._k8sCoreApi = this._kubeConfig.makeApiClient(k8s.CoreV1Api);
			this._k8sAppsApi = this._kubeConfig.makeApiClient(k8s.AppsV1Api);
			this._k8sNetworkingApi = this._kubeConfig.makeApiClient(k8s.NetworkingV1Api);
			this._k8sCustomApi = this._kubeConfig.makeApiClient(k8s.CustomObjectsApi);
			this._k8sBatchApi = this._kubeConfig.makeApiClient(k8s.BatchV1Api);

			logger.success('Successfully connected to Kubernetes cluster');
			return this;
		} catch (error) {
			logger.error(`Failed to initialize Kubernetes: ${error.message}`);
			throw error;
		}
	}

	/**
	 * Create or update a Kubernetes resource
	 * @param {Object} params - Parameters for the resource
	 * @returns {Promise<Object>} - The created or updated resource
	 */
	async createOrUpdateResource(params) {
		if (!this._k8sCoreApi || !this._k8sCustomApi) {
			throw new Error('Kubernetes controller is not initialized. Call initialize() first.');
		}

		try {
			if (!params.metadata?.name || !params.metadata?.namespace) {
				throw new Error('Parameters metadata.name and metadata.namespace are required');
			}

			const { name, namespace } = params.metadata;
			let resourceKind = params.kind;
			let exists = false;
			let resource = null;

			const isCoreResource = ['Secret', 'ConfigMap', 'Service', 'PersistentVolumeClaim'].includes(resourceKind);

			try {
				if (isCoreResource) {
					if (resourceKind === 'Secret') {
						resource = await this._k8sCoreApi.readNamespacedSecret({ name, namespace });
					} else if (resourceKind === 'ConfigMap') {
						resource = await this._k8sCoreApi.readNamespacedConfigMap({ name, namespace });
					} else if (resourceKind === 'Service') {
						resource = await this._k8sCoreApi.readNamespacedService({ name, namespace });
					} else if (resourceKind === 'PersistentVolumeClaim') {
						resource = await this._k8sCoreApi.readNamespacedPersistentVolumeClaim({ name, namespace });
					}
				} else {
					if (!params.group || !params.version || !params.plural) {
						throw new Error('Parameters group, version and plural are required for custom resources');
					}

					resource = await this._k8sCustomApi.getNamespacedCustomObject({
						group: params.group,
						version: params.version,
						kind: resourceKind,
						namespace,
						plural: params.plural,
						name,
					});
				}

				exists = true;
				logger.info(`Resource ${resourceKind} ${name} already exists, updating...`);
			} catch (error) {
				if (error.code && error.code === 404) {
					exists = false;
					logger.info(`Resource ${resourceKind} ${name} does not exist, creating...`);
				} else {
					throw error;
				}
			}

			if (exists && resource) {
				const resourceVersion = resource.body?.metadata?.resourceVersion || resource.metadata?.resourceVersion;
				if (resourceVersion) {
					params.body.metadata.resourceVersion = resourceVersion;
				}
			}

			if (exists) {
				if (isCoreResource) {
					if (resourceKind === 'Secret') {
						await this._k8sCoreApi.replaceNamespacedSecret({
							name,
							namespace,
							body: params.body,
						});
					} else if (resourceKind === 'ConfigMap') {
						await this._k8sCoreApi.replaceNamespacedConfigMap({
							name,
							namespace,
							body: params.body,
						});
					} else if (resourceKind === 'Service') {
						await this._k8sCoreApi.replaceNamespacedService({
							name,
							namespace,
							body: params.body,
						});
					}
				} else {
					await this._k8sCustomApi.replaceNamespacedCustomObject({
						group: params.group,
						version: params.version,
						kind: resourceKind,
						namespace,
						plural: params.plural,
						name,
						body: params.body,
					});
				}
				logger.success(`Resource ${resourceKind} ${name} updated successfully`);
			} else {
				if (isCoreResource) {
					if (resourceKind === 'Secret') {
						await this._k8sCoreApi.createNamespacedSecret({
							body: params.body,
							name: params.body.metadata.name,
							namespace,
						});
					} else if (resourceKind === 'ConfigMap') {
						await this._k8sCoreApi.createNamespacedConfigMap({
							body: params.body,
							name: params.body.metadata.name,
							namespace,
						});
					} else if (resourceKind === 'Service') {
						await this._k8sCoreApi.createNamespacedService({
							body: params.body,
							name: params.body.metadata.name,
							namespace,
						});
					} else if (resourceKind === 'PersistentVolumeClaim') {
						await this._k8sCoreApi.createNamespacedPersistentVolumeClaim({
							body: params.body,
							name: params.body.metadata.name,
							namespace,
						});
					}
				} else {
					await this._k8sCustomApi.createNamespacedCustomObject({
						group: params.group,
						version: params.version,
						kind: resourceKind,
						namespace,
						plural: params.plural,
						body: params.body,
					});
				}
				logger.success(`Resource ${resourceKind} ${name} created successfully`);
			}

			return {
				success: true,
				name,
				namespace,
				kind: resourceKind,
				action: exists ? 'updated' : 'created',
			};
		} catch (error) {
			logger.error(`Failed to create/update resource: ${error.message}`);
			if (error.response && error.response.body) {
				logger.error(`Error details: ${JSON.stringify(error.response.body)}`);
			}
			throw error;
		}
	}

	/**
	 * Delete a Kubernetes resource
	 * @param {Object} params - Parameters to identify the resource to delete
	 * @returns {Promise<Object>} - Result of the operation
	 */
	async deleteResource(params) {
		if (!this._k8sCoreApi || !this._k8sCustomApi) {
			throw new Error('Kubernetes controller is not initialized. Call initialize() first.');
		}

		try {
			const { name, namespace } = params;
			const resourceKind = params.kind;
			const options = params.options || { propagationPolicy: 'Foreground' };

			const isCoreResource = ['Secret', 'ConfigMap', 'Service', 'PersistentVolumeClaim', 'Job'].includes(resourceKind);

			if (isCoreResource) {
				if (resourceKind === 'Secret') {
					await this._k8sCoreApi.deleteNamespacedSecret({
						name,
						namespace,
					});
				} else if (resourceKind === 'ConfigMap') {
					await this._k8sCoreApi.deleteNamespacedConfigMap({
						name,
						namespace,
					});
				} else if (resourceKind === 'Service') {
					await this._k8sCoreApi.deleteNamespacedService({
						name,
						namespace,
					});
				} else if (resourceKind === 'PersistentVolumeClaim') {
					await this._k8sCoreApi.deleteNamespacedPersistentVolumeClaim({
						name,
						namespace,
					});
				} else if (resourceKind === 'Job') {
					await this._k8sBatchApi.deleteNamespacedJob({
						name,
						namespace,
					});
				}
			} else {
				if (!params.group || !params.version || !params.plural) {
					throw new Error('Parameters group, version and plural are required for custom resources');
				}

				await this._k8sCustomApi.deleteNamespacedCustomObject({
					group: params.group,
					version: params.version,
					kind: resourceKind,
					namespace,
					plural: params.plural,
					name,
					body: {
						apiVersion: params.group + '/' + params.version,
						kind: resourceKind,
						metadata: {
							name,
							namespace,
						},
						options,
					},
				});
			}

			logger.success(`Resource ${resourceKind} ${name} deleted successfully`);
			return {
				success: true,
				name,
				namespace,
				kind: resourceKind,
				action: 'deleted',
			};
		} catch (error) {
			if (error.response && error.response.statusCode === 404) {
				logger.info(`Resource ${params.kind} ${params.name} does not exist, nothing to delete`);
				return {
					success: true,
					name: params.name,
					namespace: params.namespace,
					kind: params.kind,
					action: 'not_found',
				};
			}

			logger.error(`Failed to delete resource: ${error.message}`);
			if (error.response && error.response.body) {
				logger.error(`Error details: ${JSON.stringify(error.response.body)}`);
			}
			throw error;
		}
	}

	/**
	 * Wait for a resource to be in the desired state
	 * @param {Object} params - Parameters to identify and check the resource
	 * @returns {Promise<boolean>} - True if condition is met, false if timeout
	 */
	async waitForResource(params) {
		if (!this._k8sCoreApi || !this._k8sCustomApi) {
			throw new Error('Kubernetes controller is not initialized. Call initialize() first.');
		}

		const { name, namespace, kind, timeout = 300000, interval = 5000 } = params;
		const condition = params.condition || (() => true);
		const startTime = Date.now();
		const isCoreResource = ['Secret', 'ConfigMap', 'Service', 'Pod', 'PersistentVolumeClaim'].includes(kind);

		logger.info(`Waiting for resource ${kind} ${name} in ${namespace}...`);

		while (Date.now() - startTime < timeout) {
			try {
				let resource = null;

				if (isCoreResource) {
					if (kind === 'Secret') {
						resource = await this._k8sCoreApi.readNamespacedSecret({
							name,
							namespace,
						});
					} else if (kind === 'ConfigMap') {
						resource = await this._k8sCoreApi.readNamespacedConfigMap({
							name,
							namespace,
						});
					} else if (kind === 'Service') {
						resource = await this._k8sCoreApi.readNamespacedService({
							name,
							namespace,
						});
					} else if (kind === 'Pod') {
						resource = await this._k8sCoreApi.readNamespacedPod({
							name,
							namespace,
						});
					} else if (kind === 'PersistentVolumeClaim') {
						resource = await this._k8sCoreApi.readNamespacedPersistentVolumeClaim({
							name,
							namespace,
						});
					}
				} else {
					if (!params.group || !params.version || !params.plural) {
						throw new Error('Parameters group, version and plural are required for custom resources');
					}

					resource = await this._k8sCustomApi.getNamespacedCustomObject({
						group: params.group,
						version: params.version,
						kind,
						namespace,
						plural: params.plural,
						name,
					});
				}

				const normalizedResource = resource.body || resource;

				if (condition(normalizedResource)) {
					logger.success(`Resource ${kind} ${name} is ready`);
					return true;
				}

				logger.info(`Resource ${kind} ${name} not ready yet, waiting...`);
			} catch (error) {
				if (error.response && error.response.statusCode === 404) {
					logger.info(`Resource ${kind} ${name} doesn't exist yet, waiting...`);
				} else {
					logger.warn(`Error checking resource: ${error.message}`);
				}
			}

			await new Promise((resolve) => setTimeout(resolve, interval));
		}

		logger.error(`Timeout waiting for resource ${kind} ${name} to be ready`);
		return false;
	}

	/**
	 * Deploy a Helm chart with custom values
	 * @param {String} chartPath - Path to the Helm chart
	 * @param {String} releaseName - Helm release name
	 * @param {String} namespace - Kubernetes namespace for deployment
	 * @param {Object} repo - Helm repository (optional)
	 * @param {String} file - Path to the values file
	 * @param {Array} overrideValues - Array of objects with name and value to replace in the values file
	 * @param {Object} options - Additional options for Helm deployment
	 * @returns {Promise<Object>} - Result of the Helm deployment
	 */
	async deployHelm(chartPath, releaseName, namespace, repo = null, file = null, overrideValues = null, options = {}) {
		try {
			logger.info(`Deploying Helm chart: ${releaseName} from ${chartPath} in namespace ${namespace}`);

			if (repo) {
				logger.info(`Adding Helm repository: ${repo.name} with URL ${repo.url}`);
				await execPromise(`helm repo add ${repo.name} ${repo.url}`);
				await execPromise('helm repo update');
			}

			const tempValuesFile = `/tmp/values-${releaseName}-${Date.now()}.yaml`;

			let valuesContent = '';
			if (file) {
				valuesContent = await fs.readFile(file, 'utf8');
			}

			if (overrideValues && Array.isArray(overrideValues)) {
				for (const { name, value } of overrideValues) {
					if (name === '__PRIVATE_KEY__') {
						const regex = new RegExp(`^([ \\t]*)${name}.*$`, 'm');
						const match = valuesContent.match(regex);

						if (match) {
							const indent = match[1];
							const indentedKey = value
								.trim()
								.split('\n')
								.map((line) => indent + line)
								.join('\n');

							valuesContent = valuesContent.replace(regex, indentedKey);
						} else {
							valuesContent = valuesContent.replace(name, value);
						}
					} else {
						valuesContent = valuesContent.replace(new RegExp(name, 'g'), value);
					}
				}
			}

			await fs.writeFile(tempValuesFile, valuesContent);

			let helmCmd = `KUBECONFIG=${this._kubeConfigPath} helm upgrade --install ${releaseName} ${chartPath} --namespace ${namespace} --values ${tempValuesFile}`;

			if (options.wait) helmCmd += ' --wait';
			if (options.timeout) helmCmd += ` --timeout ${options.timeout}`;
			if (options.debug) helmCmd += ' --debug';
			if (options.createNamespace) helmCmd += ' --create-namespace';

			const { stdout, stderr } = await execPromise(helmCmd);

			await fs.unlink(tempValuesFile);

			if (stderr && !options.debug) {
				logger.warn(`Helm stderr: ${stderr}`);
			}

			logger.success(`Successfully deployed Helm chart: ${releaseName}`);

			return {
				success: true,
				stdout,
				stderr,
				releaseName,
				namespace,
			};
		} catch (error) {
			logger.error(`Failed to deploy Helm chart: ${error.message}`);
			throw error;
		}
	}

	/**
	 * Retrieve, convert and apply YAML CRDs to Kubernetes using kubectl
	 * @param {string} url - URL of the YAML file
	 * @param {string} namespace - Kubernetes namespace (optional)
	 * @returns {Promise<Object>} - Result of kubectl apply operation
	 */
	async applyYamlFromUrl(url, namespace) {
		try {
			logger.info(`Retrieving YAML from URL: ${url}`);
			const response = await axiosClient.get(url);
			const yamlContent = response.data;

			const tempFile = `/tmp/k8s-resources-${Date.now()}.yaml`;
			await fs.writeFile(tempFile, yamlContent);

			logger.info(`Applying YAML resources from ${tempFile} using kubectl`);

			const { stdout, stderr } = await execPromise(`KUBECONFIG=${this._kubeConfigPath} kubectl apply -f ${tempFile} ${namespace ? `--namespace=${namespace}` : ''}`);

			await fs.unlink(tempFile);

			const appliedResources = stdout
				.trim()
				.split('\n')
				.filter((line) => line.length > 0)
				.map((line) => line.trim());

			if (stderr && stderr.length > 0) {
				logger.warn(`kubectl stderr: ${stderr}`);
			}

			if (appliedResources.length > 0) {
				logger.success(`Successfully applied ${appliedResources.length} resources from ${url}`);
				logger.info(`Applied resources: \n${appliedResources.join('\n')}`);
			} else {
				logger.warn(`No resources were applied from ${url}`);
			}

			return {
				success: true,
				appliedResources,
				stdout,
				stderr,
			};
		} catch (error) {
			logger.error(`Failed to apply resources from ${url}: ${error.message}`);
			throw error;
		}
	}

	/**
	 * Apply YAML directly from a string
	 * @param {string} yamlContent - YAML content to apply
	 * @param {string} namespace - Kubernetes namespace (optional)
	 * @returns {Promise<Object>} - Result of kubectl apply operation
	 */
	async applyYamlContent(yamlContent, namespace) {
		try {
			const tempFile = `/tmp/k8s-resources-direct-${Date.now()}.yaml`;
			await fs.writeFile(tempFile, yamlContent);

			logger.info(`Directly applying YAML resources using kubectl`);

			const { stdout, stderr } = await execPromise(`KUBECONFIG=${this._kubeConfigPath} kubectl apply -f ${tempFile} ${namespace ? `--namespace=${namespace}` : ''}`);

			await fs.unlink(tempFile);

			const appliedResources = stdout
				.trim()
				.split('\n')
				.filter((line) => line.length > 0)
				.map((line) => line.trim());

			if (stderr && stderr.length > 0) {
				logger.warn(`kubectl stderr: ${stderr}`);
			}

			if (appliedResources.length > 0) {
				logger.success(`Successfully applied ${appliedResources.length} YAML resources`);
				logger.info(`Applied resources: \n${appliedResources.join('\n')}`);
			} else {
				logger.warn(`No resources were applied`);
			}

			return {
				success: true,
				appliedResources,
				stdout,
				stderr,
			};
		} catch (error) {
			logger.error(`Failed to directly apply YAML resources: ${error.message}`);
			throw error;
		}
	}

	/**
	 * Execute a kubectl command with the configured kubeconfig
	 * @param {string} command - kubectl command to execute (without the `kubectl` prefix)
	 * @returns {Promise<Object>} - Result of the kubectl command
	 */
	async kubectl(command) {
		try {
			logger.info(`Executing kubectl: ${command}`);
			const { stdout, stderr } = await execPromise(`KUBECONFIG=${this._kubeConfigPath} kubectl ${command}`);

			if (stderr && stderr.length > 0) {
				logger.warn(`kubectl stderr: ${stderr}`);
			}

			return {
				success: true,
				stdout,
				stderr,
			};
		} catch (error) {
			logger.error(`Failed to execute kubectl: ${error.message}`);
			throw error;
		}
	}
}

const controller = new KubernetesController();
module.exports = controller;
