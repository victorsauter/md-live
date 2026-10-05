/** Line-ending helpers shared by the host (documents) and the tests. The webview always sees LF. */

export function toLf(text: string): string {
  return text.indexOf('\r') === -1 ? text : text.replace(/\r\n?/g, '\n');
}

export function fromLf(text: string, crlf: boolean): string {
  return crlf ? text.replace(/\n/g, '\r\n') : text;
}
