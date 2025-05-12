/**
 * Task to install and configure keycloak on Kubernetes
 */
const fs = require('fs/promises');
const kubernetesController = require('../controllers/kubernetes');
const logger = require('../utils/logger');

/**
 * Apply Keycloak CRDs
 * @returns {Promise<void>}
 */
const installKeycloakCRDs = async () => {
	await kubernetesController.applyYamlFromUrl('https://raw.githubusercontent.com/keycloak/keycloak-k8s-resources/26.2.4/kubernetes/keycloaks.k8s.keycloak.org-v1.yml');
	await kubernetesController.applyYamlFromUrl('https://raw.githubusercontent.com/keycloak/keycloak-k8s-resources/26.2.4/kubernetes/keycloakrealmimports.k8s.keycloak.org-v1.yml');
	logger.success('Keycloak CRDs installed successfully');
};

/**
 * Install Keycloak operator
 * @param {string} namespace - The namespace to install the operator in
 * @returns {Promise<void>}
 */
const installKeycloakOperator = async (namespace) => {
	await kubernetesController.applyYamlFromUrl('https://raw.githubusercontent.com/keycloak/keycloak-k8s-resources/26.2.4/kubernetes/kubernetes.yml', namespace);
	logger.success('Keycloak operator installed successfully');
};

/**
 * Create or update Keycloak Ingress
 * @param {string} namespace - Namespace for the ingress
 * @param {string} domain - Domain name
 * @returns {Promise<void>}
 */
const ensureKeycloakIngress = async (namespace, domain, systemName) => {
	const ingressName = `${systemName}-identity-ingress`;

	const resource = await getResource({
		group: 'networking.k8s.io',
		version: 'v1',
		plural: 'ingresses',
		name: ingressName,
		namespace,
		resourceType: 'Ingress',
	});

	await kubernetesController._k8sCustomApi.replaceNamespacedCustomObject({
		group: 'networking.k8s.io',
		version: 'v1',
		plural: 'ingresses',
		name: ingressName,
		namespace,
		body: {
			...resource,
			metadata: {
				...resource.metadata,
				annotations: {
					...resource.metadata.annotations,
					'cert-manager.io/cluster-issuer': systemName + '-issuer',
					'kubernetes.io/ingress.class': 'nginx',
					'nginx.ingress.kubernetes.io/backend-protocol': 'HTTPS',
				},
			},
		},
	});

	logger.success(`Updated Keycloak Ingress for auth.${domain}`);
};

/**
 * Get a K8s resource if it exists or null if it doesn't
 * @param {Object} params - Parameters for resource fetching
 * @returns {Promise<Object|null>} - The resource or null if not found
 */
const getResource = async (params) => {
	try {
		let resource;
		if (params.core) {
			resource = await kubernetesController._k8sCoreApi.readNamespacedSecret({
				name: params.name,
				namespace: params.namespace,
			});
		} else {
			resource = await kubernetesController._k8sCustomApi.getNamespacedCustomObject({
				group: params.group,
				version: params.version,
				plural: params.plural,
				name: params.name,
				namespace: params.namespace,
			});
		}
		logger.success(`${params.resourceType} ${params.name} exists, checking for updates`);
		return resource;
	} catch (error) {
		if (error.code === 404) {
			return null;
		}
		throw error;
	}
};

/**
 * Create or update DB credential secret
 * @param {string} namespace - Namespace to create the secret in
 * @param {Object} database - Database configuration
 * @returns {Promise<void>}
 */
const ensureDBCredentialsSecret = async (namespace, database) => {
	const secretName = database.password_secret;
	const resource = await getResource({
		core: true,
		name: secretName,
		namespace,
		resourceType: 'DB credentials secret',
	});

	const dbUsername = database?.username;
	const dbPassword = database?.password;

	if (!resource) {
		const secretBody = {
			apiVersion: 'v1',
			kind: 'Secret',
			metadata: {
				name: secretName,
				namespace,
				labels: {
					'cnpg.io/reload': 'true',
				},
			},
			type: 'kubernetes.io/basic-auth',
			stringData: {
				username: dbUsername,
				password: dbPassword,
			},
		};

		await kubernetesController._k8sCoreApi.createNamespacedSecret({
			namespace,
			body: secretBody,
		});
		logger.success(`Created DB credentials secret: ${secretName}`);
	} else {
		const currentResourceVersion = resource.body?.metadata?.resourceVersion || resource.metadata?.resourceVersion;

		if (!currentResourceVersion) {
			logger.warn(`Could not find resourceVersion for secret ${secretName}, skipping update`);
			return;
		}

		const secretBody = {
			apiVersion: 'v1',
			kind: 'Secret',
			metadata: {
				name: secretName,
				namespace,
				resourceVersion: currentResourceVersion,
				labels: {
					'cnpg.io/reload': 'true',
				},
			},
			type: 'kubernetes.io/basic-auth',
			stringData: {
				username: dbUsername,
				password: dbPassword,
			},
		};

		await kubernetesController._k8sCoreApi.replaceNamespacedSecret({
			name: secretName,
			namespace,
			body: secretBody,
		});
		logger.success(`Updated DB credentials secret: ${secretName}`);
	}
};

/**
 * Create or update Keycloak database
 * @param {string} namespace - Namespace for the database
 * @param {Object} database - Database configuration
 * @returns {Promise<void>}
 */
const ensureKeycloakDatabase = async (namespace, database) => {
	const resourceName = database.name;
	const resource = await getResource({
		group: 'postgresql.cnpg.io',
		version: 'v1',
		plural: 'databases',
		name: resourceName,
		namespace,
		resourceType: 'Database',
	});

	if (!resource) {
		const dbBody = {
			apiVersion: 'postgresql.cnpg.io/v1',
			kind: 'Database',
			metadata: {
				name: resourceName,
				namespace,
			},
			spec: {
				cluster: {
					name: database.cluster_name,
				},
				name: database.name,
				owner: database.username,
				passwordSecret: {
					name: database.password_secret,
				},
			},
		};

		await kubernetesController._k8sCustomApi.createNamespacedCustomObject({
			group: 'postgresql.cnpg.io',
			version: 'v1',
			plural: 'databases',
			namespace,
			body: dbBody,
		});
		logger.success(`Created Keycloak database: ${resourceName}`);
	} else {
		logger.success(`Keycloak database ${resourceName} already exists, skipping creation`);
	}
};

/**
 * Create or update TLS certificate for Keycloak
 * @param {string} namespace - Namespace for the certificate
 * @param {string} domain - Domain name
 * @param {string} name - System name
 * @returns {Promise<void>}
 */
const ensureKeycloakTLS = async (namespace, domain, name) => {
	const certName = 'keycloak-tls-secret';
	const resource = await getResource({
		group: 'cert-manager.io',
		version: 'v1',
		plural: 'certificates',
		name: certName,
		namespace,
		resourceType: 'TLS secret',
	});

	if (!resource) {
		const certBody = {
			apiVersion: 'cert-manager.io/v1',
			kind: 'Certificate',
			metadata: {
				name: certName,
				namespace,
			},
			spec: {
				dnsNames: [`auth.${domain}`],
				secretName: certName,
				issuerRef: {
					name: `${name}-issuer`,
					kind: 'ClusterIssuer',
				},
				acme: {
					config: [
						{
							http01: {
								domains: [`auth.${domain}`],
							},
						},
					],
				},
			},
		};

		await kubernetesController._k8sCustomApi.createNamespacedCustomObject({
			group: 'cert-manager.io',
			version: 'v1',
			plural: 'certificates',
			namespace,
			body: certBody,
		});
		logger.success(`Created Keycloak TLS certificate: ${certName}`);
	} else {
		const currentResourceVersion = resource.body?.metadata?.resourceVersion || resource.metadata?.resourceVersion;

		if (!currentResourceVersion) {
			logger.warn(`Could not find resourceVersion for certificate ${certName}, skipping update`);
			return;
		}

		const certBody = {
			apiVersion: 'cert-manager.io/v1',
			kind: 'Certificate',
			metadata: {
				name: certName,
				namespace,
				resourceVersion: currentResourceVersion,
			},
			spec: {
				dnsNames: [`auth.${domain}`],
				secretName: certName,
				issuerRef: {
					name: `${name}-issuer`,
					kind: 'ClusterIssuer',
				},
				acme: {
					config: [
						{
							http01: {
								domains: [`auth.${domain}`],
							},
						},
					],
				},
			},
		};

		await kubernetesController._k8sCustomApi.replaceNamespacedCustomObject({
			group: 'cert-manager.io',
			version: 'v1',
			plural: 'certificates',
			name: certName,
			namespace,
			body: certBody,
		});
		logger.success(`Updated Keycloak TLS certificate: ${certName}`);
	}
};

/**
 * Create or update Keycloak instance
 * @param {string} namespace - Namespace for Keycloak
 * @param {string} name - System name
 * @param {string} domain - Domain name
 * @param {Object} database - Database configuration
 * @returns {Promise<void>}
 */
const ensureKeycloakInstance = async (namespace, name, domain, database) => {
	const instanceName = `${name}-identity`;
	const resource = await getResource({
		group: 'k8s.keycloak.org',
		version: 'v2alpha1',
		plural: 'keycloaks',
		name: instanceName,
		namespace,
		resourceType: 'Keycloak instance',
	});

	if (!resource) {
		const keycloakBody = {
			apiVersion: 'k8s.keycloak.org/v2alpha1',
			kind: 'Keycloak',
			metadata: {
				name: instanceName,
				namespace,
			},
			spec: {
				hostname: {
					hostname: `auth.${domain}`,
				},
				db: {
					vendor: 'postgres',
					host: 'system-cluster-rw',
					port: 5432,
					database: database.name,
					usernameSecret: {
						name: database.password_secret,
						key: 'username',
					},
					passwordSecret: {
						name: database.password_secret,
						key: 'password',
					},
					poolMinSize: 30,
					poolInitialSize: 30,
					poolMaxSize: 30,
				},
				image: 'quay.io/keycloak/keycloak:26.2.4',
				startOptimized: false,
				features: {
					enabled: ['user-event-metrics'],
				},
				transaction: {
					xaEnabled: false,
				},
				additionalOptions: [
					{
						name: 'log-console-output',
						value: 'json',
					},
					{
						name: 'metrics-enabled',
						value: 'true',
					},
					{
						name: 'event-metrics-user-enabled',
						value: 'true',
					},
					{
						name: 'proxy',
						value: 'edge',
					},
					{
						name: 'proxy-headers',
						value: 'x-real-ip',
					},
				],
				http: {
					tlsSecret: 'keycloak-tls-secret',
				},
				instances: 1,
				unsupported: {
					podTemplate: {
						spec: {
							containers: [
								{
									name: 'keycloak',
									volumeMounts: [
										{
											name: 'theme-storage',
											mountPath: '/opt/keycloak/providers',
										},
									],
								},
							],
							volumes: [
								{
									name: 'theme-storage',
									persistentVolumeClaim: {
										claimName: `${name}-theme-storage`,
									},
								},
							],
						},
					},
				},
			},
		};

		await kubernetesController._k8sCustomApi.createNamespacedCustomObject({
			group: 'k8s.keycloak.org',
			version: 'v2alpha1',
			plural: 'keycloaks',
			namespace,
			body: keycloakBody,
		});
		logger.success(`Created Keycloak instance: ${instanceName}`);
	} else {
		const currentResourceVersion = resource.body?.metadata?.resourceVersion || resource.metadata?.resourceVersion;

		if (!currentResourceVersion) {
			logger.warn(`Could not find resourceVersion for Keycloak ${instanceName}, skipping update`);
			return;
		}

		const keycloakBody = {
			apiVersion: 'k8s.keycloak.org/v2alpha1',
			kind: 'Keycloak',
			metadata: {
				name: instanceName,
				namespace,
				resourceVersion: currentResourceVersion,
			},
			spec: {
				hostname: {
					hostname: `auth.${domain}`,
				},
				db: {
					vendor: 'postgres',
					host: 'system-cluster-rw',
					port: 5432,
					database: database.name,
					usernameSecret: {
						name: database.password_secret,
						key: 'username',
					},
					passwordSecret: {
						name: database.password_secret,
						key: 'password',
					},
					poolMinSize: 30,
					poolInitialSize: 30,
					poolMaxSize: 30,
				},
				image: 'quay.io/keycloak/keycloak:26.2.4',
				startOptimized: false,
				features: {
					enabled: ['user-event-metrics'],
				},
				transaction: {
					xaEnabled: false,
				},
				additionalOptions: [
					{
						name: 'log-console-output',
						value: 'json',
					},
					{
						name: 'metrics-enabled',
						value: 'true',
					},
					{
						name: 'event-metrics-user-enabled',
						value: 'true',
					},
				],
				http: {
					tlsSecret: 'keycloak-tls-secret',
				},
				instances: 1,
				unsupported: {
					podTemplate: {
						spec: {
							containers: [
								{
									name: 'keycloak',
									volumeMounts: [
										{
											name: 'theme-storage',
											mountPath: '/opt/keycloak/providers',
										},
									],
								},
							],
							volumes: [
								{
									name: 'theme-storage',
									persistentVolumeClaim: {
										claimName: `${name}-theme-storage`,
									},
								},
							],
						},
					},
				},
			},
		};

		await kubernetesController._k8sCustomApi.replaceNamespacedCustomObject({
			group: 'k8s.keycloak.org',
			version: 'v2alpha1',
			plural: 'keycloaks',
			name: instanceName,
			namespace,
			body: keycloakBody,
		});
		logger.success(`Updated Keycloak instance: ${instanceName}`);
	}
};

/**
 * Create PVC for Keycloak theme storage
 * @param {string} namespace - Namespace for the PVC
 * @param {string} systemName - System name
 * @returns {Promise<void>}
 */
const ensureKeycloakThemePVC = async (namespace, systemName, pvcName) => {
	const resource = await kubernetesController._k8sCoreApi.readNamespacedPersistentVolumeClaim({
		name: pvcName,
		namespace,
	});

	if (!resource) {
		const pvcBody = {
			apiVersion: 'v1',
			kind: 'PersistentVolumeClaim',
			metadata: {
				name: pvcName,
				namespace,
			},
			spec: {
				accessModes: ['ReadWriteMany'],
				resources: {
					requests: {
						storage: '2Gi',
					},
				},
			},
		};

		await kubernetesController._k8sCoreApi.createNamespacedPersistentVolumeClaim({
			namespace,
			body: pvcBody,
		});
		logger.success(`Created Keycloak theme PVC: ${pvcName}`);
	} else {
		logger.success(`Keycloak theme PVC ${pvcName} already exists, skipping creation`);
	}
	return pvcName;
};

/**
 * Create theme download secret with GitHub token
 * @param {string} namespace - Namespace for the secret
 * @param {string} systemName - System name
 * @param {string} githubToken - GitHub token for private repo access
 * @returns {Promise<void>}
 */
const ensureGitHubTokenSecret = async (namespace, systemName, githubToken) => {
	const secretName = `${systemName}-github-token`;
	const resource = await getResource({
		core: true,
		name: secretName,
		namespace,
		resourceType: 'GitHub token secret',
	});

	if (!resource) {
		const secretBody = {
			apiVersion: 'v1',
			kind: 'Secret',
			metadata: {
				name: secretName,
				namespace,
			},
			type: 'Opaque',
			stringData: {
				token: githubToken,
			},
		};

		await kubernetesController._k8sCoreApi.createNamespacedSecret({
			namespace,
			body: secretBody,
		});
		logger.success(`Created GitHub token secret: ${secretName}`);
	} else {
		const currentResourceVersion = resource.body?.metadata?.resourceVersion || resource.metadata?.resourceVersion;

		if (!currentResourceVersion) {
			logger.warn(`Could not find resourceVersion for secret ${secretName}, skipping update`);
			return secretName;
		}

		const secretBody = {
			apiVersion: 'v1',
			kind: 'Secret',
			metadata: {
				name: secretName,
				namespace,
				resourceVersion: currentResourceVersion,
			},
			type: 'Opaque',
			stringData: {
				token: githubToken,
			},
		};

		await kubernetesController._k8sCoreApi.replaceNamespacedSecret({
			name: secretName,
			namespace,
			body: secretBody,
		});
		logger.success(`Updated GitHub token secret: ${secretName}`);
	}
	return secretName;
};

/**
 * Create a Kubernetes Job to download and install the theme
 * @param {string} namespace - Namespace for the job
 * @param {string} systemName - System name
 * @param {string} themeVersion - Theme version to download
 * @param {string} githubTokenSecret - Secret name containing GitHub token
 * @param {string} pvcName - PVC name for theme storage
 * @returns {Promise<void>}
 */
const createThemeDownloadJob = async (namespace, systemName, themeVersion, githubTokenSecret, pvcName) => {
	const jobName = `${systemName}-theme-download`;

	try {
		await kubernetesController._k8sBatchApi.deleteNamespacedJob({
			name: jobName,
			namespace,
			propagationPolicy: 'Background',
		});
		logger.info(`Deleted existing theme download job: ${jobName}`);

		// Wait for job to be fully deleted
		await new Promise((resolve) => setTimeout(resolve, 5000));
	} catch (error) {
		if (error.code !== 404) {
			logger.warn(`Error checking/deleting existing job: ${error.message}`);
		}
	}

	const jobBody = {
		apiVersion: 'batch/v1',
		kind: 'Job',
		metadata: {
			name: jobName,
			namespace,
		},
		spec: {
			ttlSecondsAfterFinished: 86400, // Auto-delete after 1 day
			template: {
				spec: {
					containers: [
						{
							name: 'theme-downloader',
							image: 'ubuntu:22.04',
							command: ['/bin/sh', '-c'],
							args: [
								`apt-get update && apt-get install -y curl jq; \
								 ASSET_URL=$(curl -sSL -H "Authorization: token $(cat /secrets/github/token)" \
												   -H "Accept: application/vnd.github+json" \
												   "https://api.github.com/repos/xdew-studio/keycloak-theme/releases/tags/${themeVersion}" | \
											 jq -r ".assets[] | select(.name == \\"xdew-theme.jar\\") | .url"); \
								 curl -sSL -H "Authorization: token $(cat /secrets/github/token)" \
										  -H "Accept: application/octet-stream" \
										  -H "X-GitHub-Api-Version: 2022-11-28" \
										  "$ASSET_URL" -o "/themes/xdew-theme.jar"; \
								 echo "Downloaded theme version ${themeVersion} successfully"`,
							],
							volumeMounts: [
								{
									name: 'theme-storage',
									mountPath: '/themes',
								},
								{
									name: 'github-token',
									mountPath: '/secrets/github',
								},
							],
						},
					],
					restartPolicy: 'OnFailure',
					volumes: [
						{
							name: 'theme-storage',
							persistentVolumeClaim: {
								claimName: pvcName,
							},
						},
						{
							name: 'github-token',
							secret: {
								secretName: githubTokenSecret,
								items: [
									{
										key: 'token',
										path: 'token',
									},
								],
							},
						},
					],
				},
			},
		},
	};

	await kubernetesController._k8sBatchApi.createNamespacedJob({
		namespace,
		body: jobBody,
	});

	logger.success(`Created theme download job: ${jobName}`);
};

/**
 * Main task function
 * @param {Object} config - Configuration object
 * @returns {Promise<void>}
 */
const run = async (config) => {
	logger.start('Installing Keycloak on Kubernetes');

	try {
		const namespace = config.kubernetes.system.namespace;
		const systemName = config.general.name;
		const domain = config.general.domain;
		const database = config.keycloak?.database;

		const githubToken = config.general?.github_token;
		const themeVersion = config.keycloak?.theme_version;
		const pvcName = `${systemName}-theme-storage`;

		if (!githubToken) {
			throw new Error('GitHub token not provided. Set GITHUB_TOKEN environment variable.');
		}

		await kubernetesController.initialize(config.kubernetes.kubeconfigPath);

		await installKeycloakCRDs();
		await installKeycloakOperator(namespace);
		await ensureDBCredentialsSecret(namespace, database);
		await ensureKeycloakThemePVC(namespace, systemName, pvcName);
		await ensureKeycloakDatabase(namespace, database);
		await ensureKeycloakTLS(namespace, domain, systemName);
		await ensureKeycloakIngress(namespace, domain, systemName);
		await ensureKeycloakInstance(namespace, systemName, domain, database);

		const githubTokenSecret = await ensureGitHubTokenSecret(namespace, systemName, githubToken);
		await createThemeDownloadJob(namespace, systemName, themeVersion, githubTokenSecret, pvcName);

		logger.success('Keycloak installed and updated successfully with custom theme');
		return;
	} catch (error) {
		logger.error(`Failed to install/update Keycloak: ${error.message}`);
		throw error;
	}
};

module.exports = {
	run,
};
