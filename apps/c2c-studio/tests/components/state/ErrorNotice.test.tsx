import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { ErrorNotice } from '../../../src/components/state/ErrorNotice';

describe('ErrorNotice', () => {
  it('renders a generic message when no failureCode is supplied', () => {
    render(<ErrorNotice message="something broke" />);
    expect(screen.getByTestId('error-notice').textContent).toContain('something broke');
  });

  it('renders the W0.2 closed-set label and description when failureCode is supplied', () => {
    render(<ErrorNotice failureCode="model_policy_denied" />);
    const notice = screen.getByTestId('error-notice');
    expect(notice.textContent).toContain('Model invocation denied by policy');
    expect(notice.textContent).toContain('blocked by policy');
    expect(notice.textContent).toContain('code: model_policy_denied');
  });

  it('shows raw failure message alongside W0.2 explanation when both differ', () => {
    render(<ErrorNotice failureCode="oracle_mismatch" message="case01 fixture diverged" />);
    const notice = screen.getByTestId('error-notice');
    expect(notice.textContent).toContain('Output differs from the COBOL oracle');
    expect(notice.textContent).toContain('case01 fixture diverged');
  });

  it('renders unsupported-source failure copy from the closed set', () => {
    render(<ErrorNotice failureCode="unsupported_cobol" />);
    const notice = screen.getByTestId('error-notice');
    expect(notice.textContent).toContain('Unsupported COBOL');
    expect(notice.textContent).toContain('COBOL constructs outside the W0 subset');
    expect(notice.textContent).toContain('code: unsupported_cobol');
  });

  it('renders verification failure copy from the closed set', () => {
    render(<ErrorNotice failureCode="java_compile_failed" />);
    const notice = screen.getByTestId('error-notice');
    expect(notice.textContent).toContain('Generated Java did not compile');
    expect(notice.textContent).toContain('project did not compile');
    expect(notice.textContent).toContain('code: java_compile_failed');
  });
});
