/**
 * Rancher controller for managing Rancher resources
 * Updated to use v1 API and provisioning.cattle.io.clusters for creation
 */
const https = require('https');
const axios = require('axios');

const logger = require('../utils/logger');

class RancherController {
	constructor() {
		this._client = null;
		this._v1Client = null;
		this._config = null;
		this._token = null;
		this._baseUrl = null;
		this._v1BaseUrl = null;
	}

	/**
	 * Initialize and authenticate with Rancher
	 * @param {Object} config - Authentication configuration
	 * @returns {Promise<RancherController>} This instance for chaining
	 */
	async authenticate(config) {
		try {
			logger.info('Authenticating with Rancher');

			this._config = config;
			this._baseUrl = `https://${config.domain}/v3`;
			this._v1BaseUrl = `https://${config.domain}/v1`;

			const httpsAgent = new https.Agent({ rejectUnauthorized: false });

			const authResponse = await axios.post(
				`https://${config.domain}/v3-public/localProviders/local?action=login`,
				{
					username: config.username,
					password: config.password,
				},
				{
					headers: {
						'Content-Type': 'application/json',
					},
					httpsAgent,
				}
			);

			this._token = authResponse.data.token;

			this._client = axios.create({
				baseURL: this._baseUrl,
				headers: {
					'Content-Type': 'application/json',
					Authorization: `Bearer ${this._token}`,
				},
				httpsAgent,
			});

			this._v1Client = axios.create({
				baseURL: this._v1BaseUrl,
				headers: {
					'Content-Type': 'application/json',
					Authorization: `Bearer ${this._token}`,
				},
				httpsAgent,
			});

			logger.success('Successfully authenticated with Rancher');
			return this;
		} catch (error) {
			logger.error(`Rancher authentication failed: ${error.message}`);
			throw error;
		}
	}

	/**
	 * Create a Kubernetes cluster using the v1 provisioning API
	 * @param {Object} clusterConfig - Cluster configuration
	 * @returns {Promise<Object>} Created cluster
	 */
	async createCluster(clusterConfig) {
		try {
			logger.info(`Creating Kubernetes cluster: ${clusterConfig.name}`);

			const existingClusters = await this._v1Client.get('/provisioning.cattle.io.clusters');
			const existingCluster = existingClusters.data.data.find((cluster) => cluster.metadata.name === clusterConfig.name);

			if (existingCluster) {
				logger.info(`Cluster ${clusterConfig.name} already exists, using existing cluster`);
				return existingCluster;
			}

			const clusterData = {
				apiVersion: 'provisioning.cattle.io.v1',
				kind: 'Cluster',
				metadata: {
					name: clusterConfig.name,
					namespace: 'fleet-default',
				},
				spec: {
					kubernetesVersion: clusterConfig.version,
					rkeConfig: {
						chartValues: {
							'rke2-canal': {},
						},
						upgradeStrategy: {
							controlPlaneConcurrency: '1',
							controlPlaneDrainOptions: {
								enabled: true,
								deleteEmptyDirData: true,
								disableEviction: false,
								force: false,
								gracePeriod: -1,
								ignoreDaemonSets: true,
								skipWaitForDeleteTimeoutSeconds: 0,
								timeout: 120,
							},
							workerConcurrency: '1',
							workerDrainOptions: {
								enabled: true,
								deleteEmptyDirData: true,
								disableEviction: false,
								force: false,
								gracePeriod: -1,
								ignoreDaemonSets: true,
								skipWaitForDeleteTimeoutSeconds: 0,
								timeout: 120,
							},
						},
						machineGlobalConfig: {
							cni: 'canal',
							'disable-kube-proxy': false,
							'etcd-expose-metrics': false,
						},
						machineSelectorConfig: [
							{
								config: {
									'protect-kernel-defaults': false,
								},
							},
						],
						etcd: {
							disableSnapshots: false,
							snapshotRetention: 5,
							snapshotScheduleCron: '0 */5 * * *',
						},
						registries: {
							configs: {},
							mirrors: {},
						},
						machinePools: [],
						localClusterAuthEndpoint: {
							enabled: false,
							caCerts: '',
							fqdn: '',
						},
					},
				},
			};

			if (clusterConfig.machinePools) {
				clusterData.spec.rkeConfig.machinePools = clusterConfig.machinePools;
			}

			const response = await this._v1Client.post('/provisioning.cattle.io.clusters', clusterData);
			const cluster = response.data;

			logger.success(`Kubernetes cluster ${cluster.metadata.name} created successfully`);
			return cluster;
		} catch (error) {
			console.error(error);
			logger.error(`Failed to create Kubernetes cluster: ${error.message}`);
			throw error;
		}
	}

	/**
	 * Get a specific cluster by ID or name using v1 API
	 * @param {String} clusterIdOrName - Cluster ID or name
	 * @returns {Promise<Object>} Cluster object
	 */
	/**
	 * Get cluster information by ID or name
	 * Routes to V1 or V3 API based on cluster ID format
	 * @param {String} clusterIdOrName - ID or name of the cluster to retrieve
	 * @returns {Promise<Object>} - Cluster information
	 */
	async getCluster(clusterIdOrName) {
		try {
			logger.info(`Getting cluster: ${clusterIdOrName}`);

			const useV3Api = clusterIdOrName.includes('-');
			logger.debug(`Using ${useV3Api ? 'V3' : 'V1'} API for cluster: ${clusterIdOrName}`);

			if (useV3Api) {
				try {
					const response = await this._v3Client.get(`/clusters/${clusterIdOrName}`);
					return response.data;
				} catch (error) {
					if (error.response && error.response.status === 404) {
						logger.warn(`Cluster ${clusterIdOrName} not found in V3 API, falling back to cluster list search`);
						const clustersResponse = await this._v3Client.get('/clusters');
						const cluster = clustersResponse.data.data.find((c) => c.id === clusterIdOrName || c.name === clusterIdOrName);

						if (!cluster) {
							throw new Error(`Cluster ${clusterIdOrName} not found in V3 API`);
						}

						return cluster;
					}
					throw error;
				}
			} else {
				try {
					const response = await this._v1Client.get(`/provisioning.cattle.io.clusters/${clusterIdOrName}`);
					return response.data;
				} catch (error) {
					if (error.response && error.response.status === 404) {
						logger.warn(`Cluster ${clusterIdOrName} not found directly, searching in cluster list`);
						const clustersResponse = await this._v1Client.get('/provisioning.cattle.io.clusters');
						const cluster = clustersResponse.data.data.find((c) => c.metadata.name === clusterIdOrName);

						if (!cluster) {
							throw new Error(`Cluster ${clusterIdOrName} not found in V1 API`);
						}

						return cluster;
					}
					throw error;
				}
			}
		} catch (error) {
			logger.error(`Failed to get cluster: ${error.message}`);
			throw error;
		}
	}

	/**
	 * Get registration token for a cluster
	 * Note: Registration tokens might still use v3 API
	 * @param {String} clusterId - Cluster ID
	 * @returns {Promise<Object>} Registration token and command
	 */
	async getRegistrationToken(clusterId) {
		try {
			logger.info(`Getting registration token for cluster ${clusterId}`);

			const v1Cluster = await this.getCluster(clusterId);
			const v3ClusterId = v1Cluster.status?.clusterName;

			if (!v3ClusterId) {
				throw new Error('Could not determine v3 cluster ID for registration');
			}

			let registrationToken;
			try {
				const tokensResponse = await this._client.get(`/clusters/${v3ClusterId}/clusterregistrationtokens`);
				console.log(tokensResponse.data[0].token);
				registrationToken = tokensResponse.data[0].token;
			} catch (error) {
				logger.info('No existing registration token found, creating a new one');
			}

			if (!registrationToken) {
				const tokenResponse = await this._client.post(`/clusters/${v3ClusterId}/clusterregistrationtokens`, {
					clusterId: v3ClusterId,
					name: `token-${Date.now()}`,
				});
				registrationToken = tokenResponse.data;
			}

			let retries = 0;
			while (!registrationToken.nodeCommand && retries < 5) {
				await new Promise((resolve) => setTimeout(resolve, 2000));
				const tokenResponse = await this._client.get(`/clusterregistrationtokens/${registrationToken.id}`);
				registrationToken = tokenResponse.data;
				retries++;
			}

			if (!registrationToken.nodeCommand) {
				throw new Error('Failed to generate node registration command');
			}

			logger.success(`Registration token generated for cluster ${clusterId}`);
			return registrationToken;
		} catch (error) {
			logger.error(`Failed to get registration token: ${error.message}`);
			throw error;
		}
	}

	/**
	 * Get all projects in a cluster using v1 API
	 * @param {String} clusterId - Cluster ID
	 * @returns {Promise<Array>} List of projects
	 */
	async getProjects(clusterId) {
		try {
			logger.info(`Getting projects for cluster ${clusterId}`);

			const v1Cluster = await this.getCluster(clusterId);
			const v3ClusterId = v1Cluster.status?.clusterName;

			if (!v3ClusterId) {
				throw new Error('Could not determine v3 cluster ID for projects');
			}

			const response = await this._client.get(`/clusters/${v3ClusterId}/projects`);
			return response.data.data;
		} catch (error) {
			logger.error(`Failed to get projects: ${error.message}`);
			throw error;
		}
	}

	/**
	 * Create a project in a cluster
	 * @param {String} clusterId - Cluster ID
	 * @param {Object} projectConfig - Project configuration
	 * @returns {Promise<Object>} Created project
	 */
	async createProject(clusterId, projectConfig) {
		try {
			logger.info(`Creating project ${projectConfig.name} in cluster ${clusterId}`);

			const v1Cluster = await this.getCluster(clusterId);
			const v3ClusterId = v1Cluster.status?.clusterName;

			if (!v3ClusterId) {
				throw new Error('Could not determine v3 cluster ID for project creation');
			}

			const existingProjects = await this.getProjects(clusterId);
			const existingProject = existingProjects.find((project) => project.name === projectConfig.name);

			if (existingProject) {
				logger.info(`Project ${projectConfig.name} already exists, using existing project`);
				return existingProject;
			}

			const response = await this._client.post(`/projects`, {
				name: projectConfig.name,
				clusterId: v3ClusterId,
				description: projectConfig.description || `Project ${projectConfig.name}`,
			});

			logger.success(`Project ${projectConfig.name} created successfully`);
			return response.data;
		} catch (error) {
			logger.error(`Failed to create project: ${error.message}`);
			throw error;
		}
	}

	/**
	 * Create a namespace in a project
	 * @param {String} projectId - Project ID
	 * @param {Object} namespaceConfig - Namespace configuration
	 * @returns {Promise<Object>} Created namespace
	 */
	async createNamespace(projectId, namespaceConfig) {
		try {
			logger.info(`Creating namespace ${namespaceConfig.name} in project ${projectId}`);

			const v1Cluster = await this.getCluster(namespaceConfig.clusterId);
			const v3ClusterId = v1Cluster.status?.clusterName;

			if (!v3ClusterId) {
				throw new Error('Could not determine v3 cluster ID for namespace creation');
			}

			const existingNamespaces = await this._client.get(`/clusters/${v3ClusterId}/namespaces`);
			const existingNamespace = existingNamespaces.data.data.find((ns) => ns.name === namespaceConfig.name);

			if (existingNamespace) {
				if (existingNamespace.projectId !== projectId) {
					logger.info(`Namespace ${namespaceConfig.name} exists in another project, moving to ${projectId}`);

					const updateResponse = await this._client.put(`/clusters/${v3ClusterId}/namespaces/${existingNamespace.id}`, {
						...existingNamespace,
						projectId: projectId,
					});

					logger.success(`Namespace ${namespaceConfig.name} moved to project ${projectId}`);
					return updateResponse.data;
				}

				logger.info(`Namespace ${namespaceConfig.name} already exists in project ${projectId}`);
				return existingNamespace;
			}

			const response = await this._client.post(`/clusters/${v3ClusterId}/namespaces`, {
				name: namespaceConfig.name,
				projectId: projectId,
				description: namespaceConfig.description || `Namespace ${namespaceConfig.name}`,
			});

			logger.success(`Namespace ${namespaceConfig.name} created successfully`);
			return response.data;
		} catch (error) {
			logger.error(`Failed to create namespace: ${error.message}`);
			throw error;
		}
	}

	/**
	 * Apply a Kubernetes YAML manifest using v1 API
	 * @param {String} clusterId - Cluster ID
	 * @param {String} yaml - YAML manifest content
	 * @returns {Promise<Object>} Result of the apply operation
	 */
	async applyYaml(clusterId, yaml) {
		try {
			logger.info(`Applying YAML manifest to cluster ${clusterId}`);

			const v1Cluster = await this.getCluster(clusterId);
			const v3ClusterId = v1Cluster.status?.clusterName;

			if (!v3ClusterId) {
				throw new Error('Could not determine v3 cluster ID for applying YAML');
			}

			const response = await this._client.post(`/clusters/${v3ClusterId}?action=apply`, {
				yaml: yaml,
			});

			logger.success(`YAML manifest applied successfully`);
			return response.data;
		} catch (error) {
			logger.error(`Failed to apply YAML manifest: ${error.message}`);
			throw error;
		}
	}

	/**
	 * Wait for cluster to be ready/active using v1 API
	 * @param {String} clusterId - Cluster ID
	 * @param {Number} timeout - Timeout in seconds
	 * @returns {Promise<Object>} Cluster object
	 */
	async waitForClusterReady(clusterId, timeout = 600) {
		try {
			logger.waiting(`Waiting for cluster ${clusterId} to be ready`);

			const startTime = Date.now();
			const endTime = startTime + timeout * 1000;

			while (Date.now() < endTime) {
				const cluster = await this.getCluster(clusterId);

				if (cluster.status?.ready) {
					logger.success(`Cluster ${clusterId} is now active and ready`);
					return cluster;
				}

				await new Promise((resolve) => setTimeout(resolve, 10000));

				const elapsedSeconds = Math.floor((Date.now() - startTime) / 1000);
				const status = cluster.status?.conditions?.find((c) => c.type === 'Ready')?.status || 'Unknown';
				logger.progress(`Current cluster ready status: ${status}`, Math.floor((elapsedSeconds / timeout) * 100));
			}

			throw new Error(`Timeout waiting for cluster ${clusterId} to be ready`);
		} catch (error) {
			logger.error(`Error waiting for cluster: ${error.message}`);
			throw error;
		}
	}

	/**
	 * Get kubeconfig for a cluster
	 * @param {String} clusterId - Cluster ID
	 * @returns {Promise<String>} Kubeconfig content as string
	 */
	async getKubeConfig(clusterId) {
		try {
			logger.info(`Generating kubeconfig for cluster ${clusterId}`);

			const v1Cluster = await this.getCluster(clusterId);
			const v3ClusterId = v1Cluster.status?.clusterName;

			if (!v3ClusterId) {
				throw new Error('Could not determine v3 cluster ID for kubeconfig');
			}

			const response = await this._client.post(`/clusters/${v3ClusterId}?action=generateKubeconfig`);

			if (!response.data || !response.data.config) {
				throw new Error('No kubeconfig returned from Rancher API');
			}

			logger.success(`Kubeconfig for cluster ${clusterId} generated successfully`);
			return response.data.config;
		} catch (error) {
			logger.error(`Failed to get kubeconfig: ${error.message}`);
			throw error;
		}
	}
}

const controller = new RancherController();

module.exports = controller;
