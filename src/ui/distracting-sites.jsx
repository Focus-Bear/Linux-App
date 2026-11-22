import ListEditor from './list-editor.jsx';
import { useSyncedState, useUrlList } from '../services/sync.js';
import { siteError } from '../services/blocklist.js';

const Distracting_sites_page = function () {
  const { urlArray, addUrl, removeUrls, isLoading } = useUrlList();
  // Saved to the account as kImmediatelyBlockDistractingSites (same key as Mac
  // and Windows). When on, the block page has no "Unblock temporarily".
  const [immediatelyBlock, setImmediatelyBlock, isLoadingBlock] = useSyncedState('immediatelyBlock');
  // Grizzly Bear mode (Settings > Strictness) blocks outright whatever this box says.
  const [bearMode] = useSyncedState('selectedBearMode');
  const grizzly = bearMode === 'grizzly';

  return (
    <ListEditor
      title="Super Distracting Sites"
      description="Which sites do you waste time on? Focus Bear will help you be more intentional about how you use them: when you open one, it stops you and asks whether you really want to."
      items={isLoading ? [] : urlArray}
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
      validate={(value) => siteError(value, urlArray)}
      onAdd={addUrl}
      onRemove={removeUrls}
    >
      <label className="fb-check">
        <input
          type="checkbox"
          checked={Boolean(immediatelyBlock) || grizzly}
          disabled={isLoadingBlock || grizzly}
          onChange={(e) => setImmediatelyBlock(e.target.checked)}
          aria-describedby="immediately-block-help"
        />
        <span>Immediately block super distracting sites</span>
      </label>
      <p id="immediately-block-help" className="fb-check__help">
        {grizzly
          ? 'On, because you are in Grizzly Bear mode (Settings › Strictness): these sites are blocked outright.'
          : immediatelyBlock
          ? 'On: these sites are blocked outright. The block page has no "Unblock temporarily" button.'
          : 'Off: the block page lets you unblock a site for a few minutes when you really need it.'}
      </p>
    </ListEditor>
  );
};

export default Distracting_sites_page;
