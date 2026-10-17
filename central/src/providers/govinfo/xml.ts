// STUB for the red run.
export interface XmlNode { name: string; text: string; children: XmlNode[] }
export class XmlError extends Error {}
export function parseXml(_text: string, _opts: { spans?: readonly string[] } = {}): { root: XmlNode; spans: [number, number][] } {
  return { root: { name: '', text: '', children: [] }, spans: [] }
}
