/**
 * Template rendering utilities
 * Handles dynamic template variables using {{ variable }} syntax
 */

const logger = require('./logger');

/**
 * Get a nested property from an object using a dot notation path
 * @param {Object} obj - The object to get the property from
 * @param {String} path - Path to the property using dot notation (e.g., 'general.name')
 * @param {*} defaultValue - Default value if the property doesn't exist
 * @returns {*} The value of the property or the default value
 */
const getNestedValue = (obj, path, defaultValue = undefined) => {
	if (!path) return obj;

	const keys = path.split('.');
	let current = obj;

	for (const key of keys) {
		if (current === null || current === undefined || typeof current !== 'object') {
			return defaultValue;
		}
		current = current[key];
	}

	return current !== undefined ? current : defaultValue;
};

/**
 * Renders a template string by replacing variables with their values
 * @param {String} template - Template string with {{ variable }} placeholders
 * @param {Object} data - Data object containing the values for the variables
 * @param {Object} options - Additional rendering options
 * @returns {String} Rendered string with variables replaced
 */
const renderTemplate = (template, data, options = {}) => {
	if (!template) return '';
	if (typeof template !== 'string') return String(template);

	if (Array.isArray(template)) {
		return template.map((item) => renderTemplate(item, data, options)).join('');
	}

	const regex = /\{\{\s*([^\|\}]{5,})(?:\s*\|\s*([^\}]+))?\s*\}\}/g;

	return template.replace(regex, (match, path, filter) => {
		path = path.trim();

		if (path === 'x' && options.index !== undefined) {
			return options.index;
		}

		const value = getNestedValue(data, path);

		if (value === undefined) {
			if (options.silent !== true) {
				logger.warn(`Template variable '${path}' not found in data`);
			}
			return match;
		}

		if (typeof value === 'object' && value !== null) {
			return JSON.stringify(value);
		}

		return value;
	});
};

/**
 * Recursively renders all string properties in an object
 * @param {Object} obj - Object with template strings as values
 * @param {Object} data - Data object for variable replacement
 * @param {Object} options - Additional rendering options
 * @returns {Object} New object with all templates rendered
 */
const renderObject = (obj, data, options = {}) => {
	if (!obj || typeof obj !== 'object') {
		return renderTemplate(obj, data, options);
	}

	if (Array.isArray(obj)) {
		return obj.map((item, index) => {
			return renderObject(item, data, { ...options, index: index + 1 });
		});
	}

	const result = {};

	for (const [key, value] of Object.entries(obj)) {
		const renderedKey = renderTemplate(key, data, { ...options, silent: true });

		if (typeof value === 'object' && value !== null) {
			result[renderedKey] = renderObject(value, data, options);
		} else {
			result[renderedKey] = renderTemplate(value, data, options);
		}
	}

	return result;
};

module.exports = {
	renderTemplate,
	renderObject,
	getNestedValue,
};
