import type { InputHTMLAttributes } from 'react';

interface TextFieldProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'onChange'> {
  id: string;
  label: string;
  value: string;
  error?: string | undefined;
  hint?: string;
  onChange: (value: string) => void;
}

export function TextField({ id, label, value, error, hint, onChange, ...input }: TextFieldProps) {
  const describedBy = error ? `${id}-error` : hint ? `${id}-hint` : undefined;
  return (
    <div className="mb-3">
      <label htmlFor={id} className="form-label">
        {label}
      </label>
      <input
        id={id}
        className={`form-control ${error ? 'is-invalid' : ''}`}
        value={value}
        aria-invalid={Boolean(error)}
        aria-describedby={describedBy}
        onChange={(event) => onChange(event.target.value)}
        {...input}
      />
      {error ? (
        <div id={`${id}-error`} className="invalid-feedback">
          {error}
        </div>
      ) : (
        hint && (
          <div id={`${id}-hint`} className="form-text">
            {hint}
          </div>
        )
      )}
    </div>
  );
}
