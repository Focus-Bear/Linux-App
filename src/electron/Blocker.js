import { ipcMain } from 'electron';

// Import broadcast function from main (we'll export it)
let broadcastBlocklistUpdate = null;

export function setBroadcastFunction(broadcastFn) {
  broadcastBlocklistUpdate = broadcastFn;
}

ipcMain.on("url-channel", function (event, arg) {
  if (typeof arg !== 'string') return;

  const urlArray = arg
    .split('\n')
    .map(url => url.trim())
    .filter(url => url.length > 0);

  try {
    // Broadcast to native messaging hosts
    if (broadcastBlocklistUpdate) {
      broadcastBlocklistUpdate(urlArray);
    }

    console.log(`\nBroadcasting ${urlArray.length} (sub)domains to native hosts\n`);
    event.reply('reply-message', `Updated ${urlArray.length} (sub)domains!`);
  }
  catch (error){
    console.error(`\nError broadcasting blocklist: ${error.message}\n`);
    event.reply('reply-message', `Error updating blocklist: ${error.message}`);
  }

});




