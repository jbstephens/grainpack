import test from 'node:test';
import assert from 'node:assert/strict';
import { estimateTokens, tokenize, truncateText } from '../src/util.js';

test('tokenize lowercases, drops stopwords, folds plurals', () => {
  assert.deepEqual(tokenize('Why did the Q3 campaigns outperform?'), ['q3', 'campaign', 'outperform']);
  assert.deepEqual(tokenize('Emails & metrics!'), ['email', 'metric']);
  assert.deepEqual(tokenize('the a an'), []);
});

test('tokenize keeps double-s words intact', () => {
  assert.deepEqual(tokenize('business class'), ['business', 'class']);
});

test('estimateTokens is chars/4 rounded up', () => {
  assert.equal(estimateTokens('abcd'), 1);
  assert.equal(estimateTokens('abcde'), 2);
  assert.equal(estimateTokens(''), 0);
});

test('truncateText', () => {
  assert.equal(truncateText('short', 10), 'short');
  assert.equal(truncateText('a longer string', 8), 'a longe…');
});
