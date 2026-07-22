import React from 'react';
import {CircleHelp, X} from 'lucide-react';

export function HelpButton({label, onClick, className = ''}) {
  return <button
    type="button"
    className={`help-trigger ${className}`.trim()}
    title={`说明：${label}`}
    aria-label={`说明：${label}`}
    onClick={onClick}
  ><CircleHelp size={15}/></button>;
}

export function HelpDialog({title, children, onClose}) {
  if (!title) return null;
  return <div className="help-overlay" role="presentation" onMouseDown={event => {
    if (event.target === event.currentTarget) onClose();
  }}>
    <section className="help-dialog" role="dialog" aria-modal="true" aria-label={title}>
      <div className="help-dialog-head">
        <div><CircleHelp size={19}/><h3>{title}</h3></div>
        <button type="button" title="关闭说明" onClick={onClose}><X size={18}/></button>
      </div>
      <div className="help-dialog-body">{children}</div>
      <div className="help-dialog-actions"><button type="button" className="button primary" onClick={onClose}>知道了</button></div>
    </section>
  </div>;
}
