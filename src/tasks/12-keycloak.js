/**
 * Keycloak installation and configuration module for Kubernetes
 */
const fs = require('fs/promises');
const path = require('path');
const https = require('https');
const axios = require('axios');
const kubernetesController = require('../controllers/kubernetes');
const logger = require('../utils/logger');

const apiClient = axios.create({
	timeout: 30000,
	httpsAgent: new https.Agent({
		rejectUnauthorized: false,
	}),
	validateStatus: null,
});

/**
 * Main installation and configuration function for Keycloak
 * @param {Object} config - Configuration for the installation
 * @returns {Promise<void>}
 */
async function run(config) {
	try {
		logger.start('Starting Keycloak installation and configuration');

		const { general, kubernetes, keycloak } = config;
		const namespace = kubernetes.system.namespace;
		const systemName = general.name;
		const domain = general.domain;
		const keycloakUrl = `https://auth.${domain}`;
		const githubToken = general.github_token;

		await kubernetesController.initialize(kubernetes.kubeconfigPath);

		await installKeycloakCRDs();
		await installKeycloakOperator(namespace);
		await setupDatabase(namespace, systemName, keycloak.database);
		await setupTLS(namespace, systemName, domain);
		await createKeycloakInstance(namespace, systemName, domain, keycloak.database);
		await setupKeycloakIngress(namespace, systemName, domain);

		if (keycloak.theme_version && githubToken) {
			await setupCustomTheme(namespace, systemName, keycloak.theme_version, githubToken);
		}

		const isReady = await waitForKeycloakReady(namespace, systemName);
		if (!isReady) {
			throw new Error('Timeout waiting for Keycloak to be ready');
		}

		if (keycloak.admin || keycloak.identity_providers || keycloak.clients) {
			const token = await getAdminToken(keycloakUrl, namespace, systemName);

			if (keycloak.admin) {
				await createAdminUser(keycloakUrl, token, keycloak.admin);
			}

			if (keycloak.identity_providers) {
				await configureIdentityProviders(keycloakUrl, token, keycloak.identity_providers);
			}

			await applyTheme(keycloakUrl, token, 'xdew');

			if (keycloak.clients && Array.isArray(keycloak.clients)) {
				await createClients(keycloakUrl, token, keycloak.clients);
			}

			await kubernetesController.rollout(`${systemName}-identity`, namespace, 'StatefulSet');
			await kubernetesController.waitForRollout(`${systemName}-identity`, namespace, 'StatefulSet');
		}

		logger.success('Keycloak installation and configuration completed successfully');
	} catch (error) {
		logger.error(`Keycloak installation failed: ${error.message}`);
		if (error.response?.data) {
			logger.error(`API error details: ${JSON.stringify(error.response.data)}`);
		}
		throw error;
	}
}

/**
 * Install Keycloak CRDs
 * @returns {Promise<void>}
 */
async function installKeycloakCRDs() {
	logger.info('Installing Keycloak CRDs');

	await kubernetesController.applyYamlFromUrl('https://raw.githubusercontent.com/keycloak/keycloak-k8s-resources/26.2.4/kubernetes/keycloaks.k8s.keycloak.org-v1.yml');
	await kubernetesController.applyYamlFromUrl('https://raw.githubusercontent.com/keycloak/keycloak-k8s-resources/26.2.4/kubernetes/keycloakrealmimports.k8s.keycloak.org-v1.yml');

	logger.success('Keycloak CRDs installed successfully');
}

/**
 * Install Keycloak operator
 * @param {string} namespace - Namespace to install the operator
 * @returns {Promise<void>}
 */
async function installKeycloakOperator(namespace) {
	logger.info(`Installing Keycloak operator in namespace ${namespace}`);

	await kubernetesController.applyYamlFromUrl('https://raw.githubusercontent.com/keycloak/keycloak-k8s-resources/26.2.4/kubernetes/kubernetes.yml', namespace);

	logger.success('Keycloak operator installed successfully');
}

/**
 * Setup database for Keycloak
 * @param {string} namespace - Namespace for the database
 * @param {string} systemName - System name
 * @param {Object} database - Database configuration
 * @returns {Promise<void>}
 */
async function setupDatabase(namespace, systemName, database) {
	logger.info('Setting up database for Keycloak');

	const secretName = database.password_secret;
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
			username: database.username,
			password: database.password,
		},
	};

	await kubernetesController.createOrUpdateResource({
		kind: 'Secret',
		metadata: {
			name: secretName,
			namespace,
		},
		body: secretBody,
	});

	logger.success(`Database credentials secret ${secretName} created/updated`);

	const dbBody = {
		apiVersion: 'postgresql.cnpg.io/v1',
		kind: 'Database',
		metadata: {
			name: database.name,
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

	await kubernetesController.createOrUpdateResource({
		group: 'postgresql.cnpg.io',
		version: 'v1',
		plural: 'databases',
		metadata: {
			name: database.name,
			namespace,
		},
		body: dbBody,
	});

	logger.success(`Keycloak database ${database.name} created/updated`);
}

/**
 * Setup TLS for Keycloak
 * @param {string} namespace - Namespace for the certificate
 * @param {string} systemName - System name
 * @param {string} domain - Domain name
 * @returns {Promise<void>}
 */
async function setupTLS(namespace, systemName, domain) {
	logger.info('Setting up TLS certificate for Keycloak');

	const certName = 'keycloak-tls-secret';
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
				name: `${systemName}-issuer`,
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

	await kubernetesController.createOrUpdateResource({
		group: 'cert-manager.io',
		version: 'v1',
		plural: 'certificates',
		metadata: {
			name: certName,
			namespace,
		},
		body: certBody,
	});

	logger.success(`TLS certificate ${certName} created/updated`);

	const pvcName = `${systemName}-theme-storage`;
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

	await kubernetesController.createOrUpdateResource({
		kind: 'PersistentVolumeClaim',
		metadata: {
			name: pvcName,
			namespace,
		},
		body: pvcBody,
	});

	logger.success(`Theme storage PVC ${pvcName} created/updated`);
}

/**
 * Create Keycloak instance
 * @param {string} namespace - Namespace for Keycloak
 * @param {string} systemName - System name
 * @param {string} domain - Domain name
 * @param {Object} database - Database configuration
 * @returns {Promise<void>}
 */
async function createKeycloakInstance(namespace, systemName, domain, database) {
	logger.info('Creating Keycloak instance');

	const instanceName = `${systemName}-identity`;
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
									claimName: `${systemName}-theme-storage`,
								},
							},
						],
					},
				},
			},
		},
	};

	await kubernetesController.createOrUpdateResource({
		group: 'k8s.keycloak.org',
		version: 'v2alpha1',
		plural: 'keycloaks',
		metadata: {
			name: instanceName,
			namespace,
		},
		body: keycloakBody,
	});

	logger.success(`Keycloak instance ${instanceName} created/updated`);
}

/**
 * Configure Keycloak ingress
 * @param {string} namespace - Namespace for the ingress
 * @param {string} systemName - System name
 * @param {string} domain - Domain name
 * @returns {Promise<void>}
 */
async function setupKeycloakIngress(namespace, systemName, domain) {
	logger.info('Setting up Keycloak ingress');

	const ingressName = `${systemName}-identity-ingress`;

	try {
		let ingressResource;
		try {
			ingressResource = await kubernetesController._k8sCustomApi.getNamespacedCustomObject({
				group: 'networking.k8s.io',
				version: 'v1',
				plural: 'ingresses',
				name: ingressName,
				namespace,
			});
		} catch (error) {
			if (error?.code !== 404) {
				throw error;
			}
		}

		if (ingressResource) {
			const existingResource = ingressResource.body || ingressResource;

			const updatedBody = {
				...existingResource,
				metadata: {
					...existingResource.metadata,
					annotations: {
						...existingResource.metadata.annotations,
						'cert-manager.io/cluster-issuer': `${systemName}-issuer`,
						'kubernetes.io/ingress.class': 'nginx',
						'nginx.ingress.kubernetes.io/backend-protocol': 'HTTPS',
					},
				},
			};

			await kubernetesController._k8sCustomApi.replaceNamespacedCustomObject({
				group: 'networking.k8s.io',
				version: 'v1',
				plural: 'ingresses',
				name: ingressName,
				namespace,
				body: updatedBody,
			});

			logger.success(`Keycloak ingress ${ingressName} updated successfully`);
		} else {
			logger.warn(`Ingress ${ingressName} not found, it should be created by the Keycloak operator`);
		}
	} catch (error) {
		logger.error(`Error configuring ingress: ${error.message}`);
		throw error;
	}
}

/**
 * Setup custom theme for Keycloak
 * @param {string} namespace - Namespace for the job
 * @param {string} systemName - System name
 * @param {string} themeVersion - Theme version
 * @param {string} githubToken - GitHub token for accessing the theme
 * @returns {Promise<void>}
 */
async function setupCustomTheme(namespace, systemName, themeVersion, githubToken) {
	logger.info(`Setting up custom theme version ${themeVersion}`);

	const tokenSecretName = `${systemName}-github-token`;
	const tokenSecretBody = {
		apiVersion: 'v1',
		kind: 'Secret',
		metadata: {
			name: tokenSecretName,
			namespace,
		},
		type: 'Opaque',
		stringData: {
			token: githubToken,
		},
	};

	await kubernetesController.createOrUpdateResource({
		kind: 'Secret',
		metadata: {
			name: tokenSecretName,
			namespace,
		},
		body: tokenSecretBody,
	});

	logger.success(`GitHub token secret ${tokenSecretName} created/updated`);

	const jobName = `${systemName}-theme-download`;

	try {
		await kubernetesController.deleteResource({
			kind: 'Job',
			name: jobName,
			namespace,
			options: {
				propagationPolicy: 'Background',
			},
		});

		await new Promise((resolve) => setTimeout(resolve, 5000));
	} catch (error) {
		if (error?.code !== 404) {
			logger.error(`Error deleting existing job ${jobName}: ${error.message}`);
			throw error;
		} else {
			logger.info(`No existing job to delete or error`);
		}
	}

	const pvcName = `${systemName}-theme-storage`;
	const jobBody = {
		apiVersion: 'batch/v1',
		kind: 'Job',
		metadata: {
			name: jobName,
			namespace,
		},
		spec: {
			ttlSecondsAfterFinished: 86400,
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
               echo "Theme version ${themeVersion} downloaded successfully"`,
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
								secretName: tokenSecretName,
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
	logger.success(`Theme download job ${jobName} created successfully`);
}

/**
 * Wait for Keycloak to be ready
 * @param {string} namespace - Namespace where Keycloak is deployed
 * @param {string} systemName - System name
 * @param {number} timeout - Timeout in milliseconds (default: 600000ms = 10min)
 * @returns {Promise<boolean>} - True if Keycloak is ready
 */
async function waitForKeycloakReady(namespace, systemName, timeout = 600000) {
	const instanceName = `${systemName}-identity`;

	logger.info(`Waiting for Keycloak instance ${instanceName} to be ready...`);

	return await kubernetesController.waitForResource({
		group: 'k8s.keycloak.org',
		version: 'v2alpha1',
		plural: 'keycloaks',
		name: instanceName,
		namespace,
		kind: 'Keycloak',
		timeout,
		interval: 10000,
		condition: (resource) => {
			if (resource.status && resource.status.conditions.find((condition) => condition.type === 'Ready' && condition.status === 'True')) {
				return true;
			}

			logger.info(`Keycloak instance ${instanceName} not ready yet, status: ${resource.status ? JSON.stringify(resource.status) : 'unknown'}`);
			return false;
		},
	});
}

/**
 * Get admin access token
 * @param {string} keycloakUrl - Keycloak base URL
 * @param {string} namespace - Namespace where Keycloak is deployed
 * @param {string} systemName - System name
 * @returns {Promise<string>} - Access token
 */
async function getAdminToken(keycloakUrl, namespace, systemName) {
	try {
		logger.info('Getting admin access token');

		const secretName = `${systemName}-identity-initial-admin`;
		let secret;

		try {
			secret = await kubernetesController._k8sCoreApi.readNamespacedSecret({
				name: secretName,
				namespace,
			});
		} catch (error) {
			logger.error(`Unable to retrieve admin secret: ${error.message}`);
			throw new Error(`Admin secret ${secretName} not found or inaccessible`);
		}

		if (!secret || !secret.data) {
			throw new Error(`Admin secret ${secretName} invalid or empty`);
		}

		const username = Buffer.from(secret.data.username, 'base64').toString();
		const password = Buffer.from(secret.data.password, 'base64').toString();

		const tokenResponse = await apiClient.post(
			`${keycloakUrl}/realms/master/protocol/openid-connect/token`,
			new URLSearchParams({
				grant_type: 'password',
				client_id: 'admin-cli',
				username,
				password,
			}),
			{
				headers: {
					'Content-Type': 'application/x-www-form-urlencoded',
				},
			}
		);

		if (tokenResponse.status !== 200 || !tokenResponse.data.access_token) {
			throw new Error(`Authentication failed: ${JSON.stringify(tokenResponse.data)}`);
		}

		logger.success('Admin access token retrieved successfully');
		return tokenResponse.data.access_token;
	} catch (error) {
		logger.error(`Error getting access token: ${error.message}`);
		throw error;
	}
}

/**
 * Create admin user
 * @param {string} keycloakUrl - Keycloak base URL
 * @param {string} token - Admin access token
 * @param {Object} adminConfig - Admin configuration
 * @returns {Promise<void>}
 */
async function createAdminUser(keycloakUrl, token, adminConfig) {
	try {
		logger.info(`Creating admin user ${adminConfig.email}`);

		const userSearchResponse = await apiClient.get(`${keycloakUrl}/admin/realms/master/users?email=${encodeURIComponent(adminConfig.email)}`, {
			headers: {
				Authorization: `Bearer ${token}`,
			},
		});

		if (userSearchResponse.status === 200 && userSearchResponse.data.length > 0) {
			logger.info(`Admin user ${adminConfig.email} already exists`);
			return;
		}

		await apiClient.post(
			`${keycloakUrl}/admin/realms/master/users`,
			{
				username: adminConfig.email,
				email: adminConfig.email,
				enabled: true,
				emailVerified: true,
				credentials: [
					{
						type: 'password',
						value: adminConfig.password,
						temporary: false,
					},
				],
			},
			{
				headers: {
					Authorization: `Bearer ${token}`,
					'Content-Type': 'application/json',
				},
			}
		);

		const userResponse = await apiClient.get(`${keycloakUrl}/admin/realms/master/users?email=${encodeURIComponent(adminConfig.email)}`, {
			headers: {
				Authorization: `Bearer ${token}`,
			},
		});

		if (userResponse.status !== 200 || userResponse.data.length === 0) {
			throw new Error(`Could not find newly created user`);
		}

		const userId = userResponse.data[0].id;

		const rolesResponse = await apiClient.get(`${keycloakUrl}/admin/realms/master/roles`, {
			headers: {
				Authorization: `Bearer ${token}`,
			},
		});

		if (rolesResponse.status !== 200) {
			throw new Error(`Could not retrieve roles: ${JSON.stringify(rolesResponse.data)}`);
		}

		const adminRole = rolesResponse.data.find((role) => role.name === 'admin');
		if (!adminRole) {
			throw new Error(`Admin role not found`);
		}

		await apiClient.post(`${keycloakUrl}/admin/realms/master/users/${userId}/role-mappings/realm`, [adminRole], {
			headers: {
				Authorization: `Bearer ${token}`,
				'Content-Type': 'application/json',
			},
		});

		logger.success(`Admin user ${adminConfig.email} created with full privileges`);
	} catch (error) {
		logger.error(`Error creating admin user: ${error.message}`);
		throw error;
	}
}

/**
 * Configure identity providers
 * @param {string} keycloakUrl - Keycloak base URL
 * @param {string} token - Admin access token
 * @param {Object} providers - Identity providers configuration
 * @returns {Promise<void>}
 */
async function configureIdentityProviders(keycloakUrl, token, providers) {
	try {
		logger.info('Configuring identity providers');

		if (providers.github) {
			await configureProvider(keycloakUrl, token, 'github', {
				alias: 'github',
				providerId: 'github',
				enabled: true,
				updateProfileFirstLoginMode: 'on',
				trustEmail: false,
				storeToken: false,
				addReadTokenRoleOnCreate: false,
				authenticateByDefault: false,
				linkOnly: false,
				firstBrokerLoginFlowAlias: 'first broker login',
				config: {
					clientId: providers.github.client_id,
					clientSecret: providers.github.client_secret,
					useJwksUrl: true,
				},
			});
		}

		if (providers.google) {
			await configureProvider(keycloakUrl, token, 'google', {
				alias: 'google',
				providerId: 'google',
				enabled: true,
				updateProfileFirstLoginMode: 'on',
				trustEmail: true,
				storeToken: false,
				addReadTokenRoleOnCreate: false,
				authenticateByDefault: false,
				linkOnly: false,
				firstBrokerLoginFlowAlias: 'first broker login',
				config: {
					clientId: providers.google.client_id,
					clientSecret: providers.google.client_secret,
					defaultScope: 'openid email profile',
					useJwksUrl: true,
				},
			});
		}

		logger.success('Identity providers configured successfully');
	} catch (error) {
		logger.error(`Error configuring identity providers: ${error.message}`);
		throw error;
	}
}

/**
 * Configure an identity provider
 * @param {string} keycloakUrl - Keycloak base URL
 * @param {string} token - Admin access token
 * @param {string} alias - Provider alias
 * @param {Object} config - Provider configuration
 * @returns {Promise<void>}
 * @private
 */
async function configureProvider(keycloakUrl, token, alias, config) {
	try {
		let providerExists = false;

		try {
			const response = await apiClient.get(`${keycloakUrl}/admin/realms/master/identity-provider/instances/${alias}`, {
				headers: {
					Authorization: `Bearer ${token}`,
				},
			});

			providerExists = response.status === 200;
		} catch (error) {
			if (error.response?.status !== 404) {
				logger.warn(`Error checking provider ${alias}: ${error.message}`);
			}
		}

		if (providerExists) {
			await apiClient.put(`${keycloakUrl}/admin/realms/master/identity-provider/instances/${alias}`, config, {
				headers: {
					Authorization: `Bearer ${token}`,
					'Content-Type': 'application/json',
				},
			});

			logger.success(`Identity provider ${alias} updated`);
		} else {
			await apiClient.post(`${keycloakUrl}/admin/realms/master/identity-provider/instances`, config, {
				headers: {
					Authorization: `Bearer ${token}`,
					'Content-Type': 'application/json',
				},
			});

			logger.success(`Identity provider ${alias} created`);
		}
	} catch (error) {
		logger.error(`Error configuring provider ${alias}: ${error.message}`);
		throw error;
	}
}

/**
 * Apply theme to Keycloak
 * @param {string} keycloakUrl - Keycloak base URL
 * @param {string} token - Admin access token
 * @param {string} themeName - Theme name
 * @returns {Promise<void>}
 */
async function applyTheme(keycloakUrl, token, themeName) {
	try {
		logger.info(`Applying theme ${themeName} to Keycloak`);

		const realmResponse = await apiClient.get(`${keycloakUrl}/admin/realms/master`, {
			headers: {
				Authorization: `Bearer ${token}`,
			},
		});

		if (realmResponse.status !== 200) {
			throw new Error(`Could not retrieve realm configuration: ${JSON.stringify(realmResponse.data)}`);
		}

		const realmConfig = realmResponse.data;
		realmConfig.loginTheme = themeName;

		const updateResponse = await apiClient.put(`${keycloakUrl}/admin/realms/master`, realmConfig, {
			headers: {
				Authorization: `Bearer ${token}`,
				'Content-Type': 'application/json',
			},
		});

		if (updateResponse.status !== 204) {
			throw new Error(`Failed to apply theme: ${JSON.stringify(updateResponse.data)}`);
		}

		logger.success(`Theme ${themeName} applied successfully`);
	} catch (error) {
		logger.error(`Error applying theme: ${error.message}`);
		throw error;
	}
}

/**
 * Create OAuth clients
 * @param {string} keycloakUrl - Keycloak base URL
 * @param {string} token - Admin access token
 * @param {Array} clients - Clients configuration
 * @returns {Promise<void>}
 */
async function createClients(keycloakUrl, token, clients) {
	try {
		logger.info('Creating OAuth clients');

		for (const clientConfig of clients) {
			await createOrUpdateClient(keycloakUrl, token, clientConfig);
		}

		logger.success('OAuth clients created/updated successfully');
	} catch (error) {
		logger.error(`Error creating OAuth clients: ${error.message}`);
		throw error;
	}
}

/**
 * Create or update an OAuth client
 * @param {string} keycloakUrl - Keycloak base URL
 * @param {string} token - Admin access token
 * @param {Object} clientConfig - Client configuration
 * @returns {Promise<void>}
 * @private
 */
async function createOrUpdateClient(keycloakUrl, token, clientConfig) {
	try {
		logger.info(`Configuring OAuth client ${clientConfig.client_id}`);

		let clientExists = false;
		let existingClientId = null;

		const clientSearchResponse = await apiClient.get(`${keycloakUrl}/admin/realms/master/clients?clientId=${encodeURIComponent(clientConfig.client_id)}`, {
			headers: {
				Authorization: `Bearer ${token}`,
			},
		});

		if (clientSearchResponse.status === 200 && clientSearchResponse.data.length > 0) {
			clientExists = true;
			existingClientId = clientSearchResponse.data[0].id;
		}

		const clientBody = {
			clientId: clientConfig.client_id,
			name: clientConfig.name || clientConfig.client_id,
			description: clientConfig.description || '',
			enabled: true,
			protocol: 'openid-connect',
			publicClient: !!clientConfig.public_client,
			directAccessGrantsEnabled: !!clientConfig.direct_grants_enabled,
			standardFlowEnabled: clientConfig.standard_flow_enabled !== false,
			implicitFlowEnabled: !!clientConfig.implicit_flow_enabled,
			serviceAccountsEnabled: !!clientConfig.service_accounts_enabled,
			authorizationServicesEnabled: !!clientConfig.authorization_services_enabled,
			redirectUris: clientConfig.redirect_uris || [],
			webOrigins: clientConfig.web_origins || [],
			attributes: clientConfig.attributes || {},
			rootUrl: clientConfig.root_url || '',
		};

		if (clientConfig.client_secret && !clientConfig.public_client) {
			clientBody.secret = clientConfig.client_secret;
		}

		if (clientExists && existingClientId) {
			await apiClient.put(`${keycloakUrl}/admin/realms/master/clients/${existingClientId}`, clientBody, {
				headers: {
					Authorization: `Bearer ${token}`,
					'Content-Type': 'application/json',
				},
			});

			logger.success(`OAuth client ${clientConfig.client_id} updated`);
		} else {
			await apiClient.post(`${keycloakUrl}/admin/realms/master/clients`, clientBody, {
				headers: {
					Authorization: `Bearer ${token}`,
					'Content-Type': 'application/json',
				},
			});

			logger.success(`OAuth client ${clientConfig.client_id} created`);
		}
	} catch (error) {
		logger.error(`Error configuring client ${clientConfig.client_id}: ${error.message}`);
		throw error;
	}
}

module.exports = {
	run,
};
