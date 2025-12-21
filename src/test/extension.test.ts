import * as assert from 'assert';
import * as vscode from 'vscode';

suite('Linearizer Extension', () => {
	test('registers showChangedFunctions command', async () => {
		const extension = vscode.extensions.all.find((ext) => ext.packageJSON.name === 'linearizer');
		assert.ok(extension, 'Linearizer extension should be available');
		if (extension && !extension.isActive) {
			await extension.activate();
		}
		const allCommands = await vscode.commands.getCommands(true);
		assert.ok(
			allCommands.includes('linearizer.showChangedFunctions'),
			"Expected command 'linearizer.showChangedFunctions' to be registered",
		);
	});
});
