import { defineConfig } from 'vitest/config';
import * as path from 'path';

export default defineConfig({
	test: {
		globals: true,
		include: ['tests/**/*.test.ts'],
	},
	resolve: {
		alias: {
			// Redirect the Obsidian Electron package to a lightweight stub
			// so unit tests can run in a plain Node environment.
			obsidian: path.resolve(__dirname, 'tests/__mocks__/obsidian.ts'),
		},
	},
});
