import { afterEach, expect, it, vi } from 'vitest';
import { loadPitchModelBytes } from './loadPitchModel';
afterEach(() => vi.unstubAllGlobals());
it.each([[200,'text/html'],[404,'application/octet-stream']])('rejects HTTP %s / %s', async (status,type) => {
  vi.stubGlobal('fetch',vi.fn().mockResolvedValue(new Response('<html/>',{status,headers:{'content-type':type}})));
  await expect(loadPitchModelBytes('/pitch.glb',new AbortController().signal)).rejects.toThrow(`HTTP ${status}`);
});
it('rejects HTML disguised as a binary response',async () => {
  vi.stubGlobal('fetch',vi.fn().mockResolvedValue(new Response('<html>SPA fallback document</html>',{headers:{'content-type':'application/octet-stream'}})));
  await expect(loadPitchModelBytes('/pitch.glb',new AbortController().signal)).rejects.toThrow('GLB 2.0');
});
it('passes valid binary through unchanged and propagates abort signal',async () => {
  const bytes=new ArrayBuffer(20);const header=new DataView(bytes);
  header.setUint32(0,0x46546c67,true);header.setUint32(4,2,true);header.setUint32(8,20,true);
  const fetcher=vi.fn().mockResolvedValue(new Response(bytes));vi.stubGlobal('fetch',fetcher);
  const signal=new AbortController().signal;
  expect(await loadPitchModelBytes('/pitch.glb',signal)).toEqual(bytes);
  expect(fetcher).toHaveBeenCalledWith('/pitch.glb',{signal});
});
