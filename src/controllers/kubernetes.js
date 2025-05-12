const fs = require('fs').promises;
const logger = require('../utils/logger');
const { exec } = require('child_process');
const util = require('util');
const axios = require('axios');
const yaml = require('js-yaml');
const execPromise = util.promisify(exec);

class KubernetesController {
	constructor() {
		this._kubeConfig = null;
		this._k8sCoreApi = null;
		this._k8sAppsApi = null;
		this._k8sNetworkingApi = null;
		this._k8sCustomApi = null;
		this._k8sModule = null;
		this._k8sBatchApi = null;
	}

	/**
	 * Initialize the controller with a kubeconfig file
	 * @param {String} kubeconfigPath - Path to kubeconfig file
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
			logger.error(`Kubernetes initialization failed: ${error.message}`);
			throw error;
		}
	}

	/**
	 * Deploy a Helm chart with custom values
	 * @param {String} chartPath - Path to the Helm chart
	 * @param {String} releaseName - Name of the Helm release
	 * @param {String} namespace - Kubernetes namespace to deploy in
	 * @param {String} file - Path to the values file
	 * @param {Array} overrideValues - Array of objects with name and value to override in the values file
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
			logger.error(`Helm deployment failed: ${error.message}`);
			throw error;
		}
	}

	/**
	 * Fetch, convert and apply YAML CRDs to Kubernetes using kubectl
	 * @param {string} url - The URL of the YAML file
	 * @returns {Promise<Object>} - Result of the kubectl apply operation
	 */
	async applyYamlFromUrl(url, namespace) {
		try {
			logger.info(`Fetching YAML from URL: ${url}`);
			const response = await axios.get(url);
			const yamlContent = response.data;

			// Create a temporary file to store the YAML content
			const tempFile = `/tmp/k8s-resources-${Date.now()}.yaml`;
			await fs.writeFile(tempFile, yamlContent);

			logger.info(`Applying YAML resources from ${tempFile} using kubectl`);

			// Use kubectl apply with the kubeconfig specified
			const { stdout, stderr } = await execPromise(`KUBECONFIG=${this._kubeConfigPath} kubectl apply -f ${tempFile} ${namespace ? `--namespace=${namespace}` : ''}`);

			// Remove the temporary file
			await fs.unlink(tempFile);

			// Process the output to extract what was applied
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
}

const controller = new KubernetesController();
module.exports = controller;
