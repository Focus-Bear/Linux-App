import { useEffect, useState } from 'react';
import ListEditor from './list-editor.jsx';

const Keywords_page = function () {
  const [keywords, setKeywords] = useState('');

  useEffect(function () {
    window.api?.printList(keywords);
    window.api?.exportKeywords?.(keywords);
  }, [keywords]);

  const kwList = keywords.split('\n').filter((keyword) => keyword.trim());

  const addKeyword = (value) => {
    setKeywords(keywords + (keywords ? '\n' : '') + value);
  };

  const removeKeywords = (indices) => {
    setKeywords(kwList.filter((_, index) => !indices.has(index)).join('\n'));
  };

  return (
    <ListEditor
      title="Keyword Blocking"
      description="Which keywords are problematic? Sites containing these keywords are blocked during focus sessions. The rest of the time, Focus Bear asks why you want to visit them."
      items={kwList}
      emptyText="No keywords yet."
      addLabel="Add Keyword"
      dialogTitle="Add a keyword"
      placeholder="e.g. celebrity"
      onAdd={addKeyword}
      onRemove={removeKeywords}
    />
  );
};

export default Keywords_page;
