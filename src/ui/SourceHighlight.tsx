import { highlightParts } from './reviewModel.ts';
import type { EvidenceSpan } from './reviewModel.ts';
import type { NormalisedMessage } from '../core/index.ts';

export function SourceHighlight({ messages, evidence }: { readonly messages: readonly NormalisedMessage[]; readonly evidence: readonly EvidenceSpan[] }) {
  return <div className="source-list">{messages.map((message, index) => <article className="source-message" key={message.id}>
    <div className="eyebrow">Message {index + 1} <span className="muted">· {message.id}</span></div>
    <p>{highlightParts(message, evidence).map((part, i) => part.highlighted ? <mark key={i}>{part.text}</mark> : <span key={i}>{part.text}</span>)}</p>
  </article>)}</div>;
}
