/**
 * Logging utility with colored output
 */

const readline = require('readline');

const rl = readline.createInterface({
	input: process.stdin,
	output: process.stdout,
});

const colors = {
	reset: '\x1b[0m',
	bright: '\x1b[1m',
	dim: '\x1b[2m',
	underscore: '\x1b[4m',
	blink: '\x1b[5m',
	reverse: '\x1b[7m',
	hidden: '\x1b[8m',

	black: '\x1b[30m',
	red: '\x1b[31m',
	green: '\x1b[32m',
	yellow: '\x1b[33m',
	blue: '\x1b[34m',
	magenta: '\x1b[35m',
	cyan: '\x1b[36m',
	white: '\x1b[37m',

	bgBlack: '\x1b[40m',
	bgRed: '\x1b[41m',
	bgGreen: '\x1b[42m',
	bgYellow: '\x1b[43m',
	bgBlue: '\x1b[44m',
	bgMagenta: '\x1b[45m',
	bgCyan: '\x1b[46m',
	bgWhite: '\x1b[47m',
};

const getTimestamp = () => {
	const now = new Date();
	return `${now.toISOString().replace('T', ' ').substr(0, 19)}`;
};

const formatMessage = (color, prefix, message) => {
	return `${colors.dim}[${getTimestamp()}]${colors.reset} ${color}${prefix}${colors.reset} ${message}`;
};

const logger = {
	debug: (message) => {
		console.log(formatMessage(colors.cyan, '[DEBUG]', message));
	},

	log: (message) => {
		console.log(formatMessage(colors.blue, '[INFO]', message));
	},

	info: (message) => {
		console.log(formatMessage(colors.blue, '[INFO]', message));
	},

	warn: (message) => {
		console.log(formatMessage(colors.yellow, '[WARN]', message));
	},

	waring: (message) => {
		console.log(formatMessage(colors.yellow, '[WARNING]', message));
	},

	error: (message) => {
		console.log(formatMessage(colors.red, '[ERROR]', message));
	},

	success: (message) => {
		console.log(formatMessage(colors.green, '[SUCCESS]', message));
	},

	start: (message) => {
		console.log(formatMessage(colors.magenta, '[START]', message));
	},

	progress: (message, percentage) => {
		const percent = percentage ? ` (${percentage}%)` : '';
		console.log(formatMessage(colors.cyan, '[PROGRESS]', `${message}${percent}`));
	},

	waiting: (message) => {
		console.log(formatMessage(colors.yellow, '[WAITING]', message));
	},

	promptUser: (message) => {
		return new Promise((resolve) => {
			rl.question(`${message} (y/n): `, (answer) => {
				rl.close();
				resolve(answer.toLowerCase() === 'y' || answer.toLowerCase() === 'yes');
			});
		});
	},
};

module.exports = logger;
