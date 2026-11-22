import assert from 'node:assert/strict';
import test from 'node:test';
import { checkLinks, checkMaterials, parseTable } from '../tools/check-materials.mjs';

test('交接资料按清单可读取，引用目标可定位', async () => {
  const counts = Object.values(await checkMaterials());
  assert.ok(counts.length > 0);
  assert.ok(counts.every(count => Number.isInteger(count) && count > 0));
});

test('字段缺省保持为空，格式错误指出资料行号', () => {
  assert.deepEqual(parseTable('id,note\nX,\n', ['id', 'note'], '交接'), [{ id: 'X', note: '' }]);
  assert.throws(() => parseTable('id,note\nX\n', ['id', 'note'], '交接'), /第 2 行/);
});

test('原始资料允许空引用，已填引用须有对应条目', () => {
  const parents = [{ id: 'C1' }];
  const links = [['children', 'parent', 'parents', 'id']];
  assert.doesNotThrow(() => checkLinks({ parents, children: [{ parent: '' }, { parent: 'C1' }] }, links));
  assert.throws(() => checkLinks({ parents, children: [{ parent: 'C2' }] }, links), /C2/);
});
