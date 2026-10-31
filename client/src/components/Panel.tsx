import type { ReactNode } from 'react';

interface PanelProps {
  title: string;
  actions?: ReactNode;
  className?: string;
  children: ReactNode;
}

/** The bordered box every trading widget sits in. */
export function Panel({ title, actions, className = '', children }: PanelProps) {
  return (
    <section className={`panel ${className}`} aria-label={title}>
      <header className="panel-header">
        <h2 className="panel-title">{title}</h2>
        {actions}
      </header>
      <div className="panel-body">{children}</div>
    </section>
  );
}
