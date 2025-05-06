/**
 * Configuration loader and validator
 */
const fs = require('fs').promises;
const path = require('path');
const logger = require('./logger');
const { renderObject } = require('./template');

const CONFIG_PATH = '/keybase/team/xdew.admin/config.json';

/**
 * Load configuration from a JSON or JS file
 * @param {String} [configPath] - Optional path to configuration file
 * @returns {Object} Loaded and processed configuration object
 */
const loadConfig = async (configPath = CONFIG_PATH) => {
	try {
		if (!configPath) {
			const possiblePaths = [path.join(process.cwd(), 'config.json'), path.join(process.cwd(), 'config.js'), path.join(__dirname, '..', '..', 'config.json'), path.join(__dirname, '..', '..', 'config.js')];

			for (const p of possiblePaths) {
				try {
					await fs.access(p);
					configPath = p;
					break;
				} catch (e) {}
			}

			if (!configPath) {
				throw new Error('Configuration file not found');
			}
		}

		logger.info(`Loading configuration from: ${configPath}`);

		let config;
		console.log('configPath', configPath);
		if (configPath.endsWith('.js')) {
			config = require(configPath);
		} else {
			const content = await fs.readFile(configPath, 'utf8');
			config = JSON.parse(content);
		}

		config.configPath = configPath;

		const processedConfig = await processConfig(config);
		return processedConfig;
	} catch (error) {
		logger.error(`Failed to load configuration: ${error.message}`);
		throw error;
	}
};

/**
 * Process and validate the configuration
 * @param {Object} config - Raw configuration object
 * @returns {Object} Processed configuration with templates rendered
 */
const processConfig = async (config) => {
	const requiredSections = ['general', 'openstack', 'rancher', 'kubernetes', 'cloudflare'];

	for (const section of requiredSections) {
		if (!config[section]) {
			throw new Error(`Required configuration section '${section}' is missing`);
		}
	}

	let renderedConfig = renderObject(config, config);
	renderedConfig = renderObject(renderedConfig, renderedConfig);

	validateCriticalValues(renderedConfig);
	return renderedConfig;
};

/**
 * Validate that critical configuration values are present
 * @param {Object} config - Configuration object to validate
 */
const validateCriticalValues = (config) => {
	if (!config.openstack.auth.auth_url || !config.openstack.auth.application_credential_id) {
		throw new Error('OpenStack authentication configuration is incomplete');
	}

	if (!config.openstack.network.name || !config.openstack.network.subnets) {
		throw new Error('Network configuration is incomplete');
	}

	if (!config.openstack.vms.rancher || !config.openstack.vms.master || !config.openstack.vms.worker) {
		throw new Error('VM configuration is incomplete');
	}

	if (!config.rancher.domain || !config.rancher.admin_password) {
		throw new Error('Rancher configuration is incomplete');
	}

	if (!config.cloudflare.api_token || !config.cloudflare.domain) {
		throw new Error('Cloudflare configuration is incomplete');
	}

	logger.info('Configuration validation passed');
};

/**
 * Update a configuration value using a dot notation path
 * @param {Object} config - Configuration object to update
 * @param {String} path - Dot notation path to the property (e.g., 'openstack.vms.worker.id')
 * @param {any} value - New value to set
 * @returns {Object} Updated configuration object
 */
const updateConfigValue = (config, path, value) => {
	if (!config || typeof config !== 'object') {
		throw new Error('Invalid configuration object');
	}

	if (!path || typeof path !== 'string') {
		throw new Error('Path must be a non-empty string');
	}

	const keys = path.split('.');
	let current = config;

	for (let i = 0; i < keys.length - 1; i++) {
		const key = keys[i];

		if (!current[key] || typeof current[key] !== 'object') {
			current[key] = {};
		}

		current = current[key];
	}

	const finalKey = keys[keys.length - 1];
	current[finalKey] = value;

	return config;
};

/**
 * Update the configuration with new values and save it
 * @param {String} path - Dot notation path to the property to update
 * @param {any} value - New value to set
 * @param {String} [configPath] - Optional path to save the config (defaults to stored path or CONFIG_PATH)
 * @returns {Promise<Object>} - Updated configuration
 */
const updateConfig = async (path, value, configPath = null) => {
	try {
		const config = await loadConfig(configPath);

		updateConfigValue(config, path, value);

		const savePath = config.configPath || CONFIG_PATH;

		await saveConfig(config, savePath);

		return config;
	} catch (error) {
		logger.error(`Failed to update configuration: ${error.message}`);
		throw error;
	}
};

/**
 * Save the current configuration state to a file
 * @param {Object} config - Configuration object to save
 * @param {String} [outputPath] - Path to save the file (defaults to stored path or CONFIG_PATH)
 * @returns {Promise<void>}
 */
const saveConfig = async (config, outputPath = null) => {
	try {
		const savePath = outputPath || config.configPath || CONFIG_PATH;

		const configToSave = { ...config };
		delete configToSave.configPath;

		const content = JSON.stringify(configToSave, null, 2);
		await fs.writeFile(savePath, content, 'utf8');
		logger.info(`Configuration saved to: ${savePath}`);
	} catch (error) {
		logger.error(`Failed to save configuration: ${error.message}`);
		throw error;
	}
};

/**
 * Direct access to update a single config value and save
 * @param {String} path - Dot notation path to update
 * @param {any} value - Value to set at the path
 * @returns {Promise<Object>} - Updated configuration
 */
const setConfigValue = async (path, value) => {
	return updateConfig(path, value);
};

module.exports = {
	loadConfig,
	saveConfig,
	updateConfig,
	updateConfigValue,
	setConfigValue,
};

//
