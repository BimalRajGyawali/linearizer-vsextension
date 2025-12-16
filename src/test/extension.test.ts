import * as assert from 'assert';
import * as vscode from 'vscode';

suite('Linearizer Extension', () => {
	test('registers showChangedFunctions command', async () => {
		const allCommands = await vscode.commands.getCommands(true);
		assert.ok(
			allCommands.includes('linearizer.showChangedFunctions'),
			"Expected command 'linearizer.showChangedFunctions' to be registered",
		);
	});
});
