import { useEffect, useState } from 'react';
import ListEditor from './list-editor.jsx';
import { useUrlList } from '../services/sync.js';

const Distracting_sites_page = function () {
  // Not wired to anything yet (it wasn't before either); see the "Immediately block" issue.
  const [instantBlock, setInstantBlock] = useState(false);
  const { urlArray, addUrl, removeUrls, isLoading } = useUrlList();

  useEffect(function () {
    if (!isLoading && urlArray) {
      window.api?.printList(urlArray.join('\n'));
    }
  }, [urlArray, isLoading]);

  return (
    <ListEditor
      title="Super Distracting Sites"
      description="Which sites do you waste time on? Focus Bear will help you be more intentional about how you use them. They're blocked during focus sessions; the rest of the time Focus Bear asks why you want to open them."
      items={isLoading ? [] : urlArray || []}
      emptyText={isLoading ? 'Loading your sites…' : 'No sites yet. Add one to get started.'}
      addLabel="Add URL"
      dialogTitle="Add a website"
      placeholder="facebook.com"
      help={
        <>
          <div>To block a website: <code>domain.com</code></div>
          <div>To block all its subdomains: <code>*.domain.com</code></div>
        </>
      }
      onAdd={addUrl}
      onRemove={removeUrls}
    >
      <label className="fb-check">
        <input type="checkbox" checked={instantBlock} onChange={(e) => setInstantBlock(e.target.checked)} />
        <span>Immediately block super distracting sites</span>
      </label>
    </ListEditor>
  );
};

export default Distracting_sites_page;
