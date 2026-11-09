// Legacy help choices represent a request for missing information, not a factual confirmation.
export function requiresReply(options: readonly string[]): boolean {
  return options.length === 2 && options[0] === "我已处理，重新核实" && options[1] === "先暂停此目标";
}
export function validReply(text: unknown): text is string {
  return (
    typeof text === "string" &&
    text.trim().length > 0 &&
    [...text].length <= 1000 &&
    !/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(text)
  );
}
