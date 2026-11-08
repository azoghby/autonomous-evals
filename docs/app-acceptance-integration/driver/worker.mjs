import { pathToFileURL } from 'node:url';
// Workers have no public listener. Only the parent supplies the compiled owned app module.
process.once('message', async ({ modulePath, input }) => {
  let n = 0;
  const beforeDispatch = intent => new Promise((resolve, reject) => {
    const id = ++n;
    const onMessage = message => { if (message.type === 'ack' && message.id === id) { process.off('message', onMessage); resolve(); } };
    process.on('message', onMessage);
    process.send({ type: 'dispatch', id, intent }, error => { if (error) reject(error); });
  });
  try {
    const module = await import(pathToFileURL(modulePath));
    const value = await module.executeAppPhase(input, beforeDispatch);
    process.send({ type: 'result', value }, () => process.exit(0));
  } catch { process.send({ type: 'failure' }, () => process.exit(1)); }
});
