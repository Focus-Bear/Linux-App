import ListEditor from './list-editor.jsx';
import { useKeywordList } from '../services/sync.js';
import { keywordError } from '../services/blocklist.js';

/**
 * Blocking > Keyword Blocking. Keywords are saved with the account's block list
 * (entries without a dot, as in the Mac and Windows apps), so they survive
 * navigation and restarts, sync between devices and reach the browser extension.
 */
const Keywords_page = function () {
  const { keywords, addKeyword, removeKeywords, isLoading } = useKeywordList();

  return (
    <ListEditor
      title="Keyword Blocking"
      description="Which keywords are problematic? Pages with one of these words in their address are blocked, the same way your super distracting sites are."
      items={isLoading ? [] : keywords}
      emptyText={isLoading ? 'Loading your keywords…' : 'No keywords yet.'}
      addLabel="Add Keyword"
      dialogTitle="Add a keyword"
      placeholder="e.g. celebrity"
      validate={(value) => keywordError(value, keywords)}
      onAdd={addKeyword}
      onRemove={removeKeywords}
    />
  );
};

export default Keywords_page;
