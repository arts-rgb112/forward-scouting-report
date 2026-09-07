/** Validate the deployed binary before giving it to GLTFLoader (SPA fallback is HTML). */
export async function loadPitchModelBytes(url: string, signal: AbortSignal): Promise<ArrayBuffer> {
  const response = await fetch(url, { signal });
  const contentType = response.headers.get('content-type') ?? 'unknown';
  const diagnostic = `HTTP ${response.status}; content-type=${contentType}`;
  if (!response.ok || /(?:text\/html|application\/xhtml)/i.test(contentType)) {
    throw new Error(`경기장 모델 응답 오류 (${diagnostic})`);
  }
  const data = await response.arrayBuffer();
  if (data.byteLength < 20) throw new Error(`경기장 모델 파일이 불완전합니다 (${diagnostic})`);
  const header = new DataView(data);
  if (header.getUint32(0, true) !== 0x46546c67 || header.getUint32(4, true) !== 2 ||
      header.getUint32(8, true) !== data.byteLength) {
    throw new Error(`유효한 GLB 2.0 파일이 아닙니다 (${diagnostic})`);
  }
  return data;
}
