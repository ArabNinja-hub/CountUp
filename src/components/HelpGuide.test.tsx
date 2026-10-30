// @vitest-environment jsdom
import React, { useCallback, useState } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { HelpGuide } from './HelpGuide';

afterEach(cleanup);

function GuideHost() {
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);
  return (
    <>
      <button onClick={() => setOpen(true)}>Open guide</button>
      {open && <HelpGuide onClose={close} />}
    </>
  );
}

describe('Instruction guide', () => {
  it('offers a short quick start and expandable instructions, and returns focus on close', () => {
    render(<GuideHost />);
    const open = screen.getByRole('button', { name: 'Open guide' });
    open.focus();
    fireEvent.click(open);
    const guide = screen.getByRole('dialog', { name: 'How to use CountUp' });
    expect(within(guide).getByText('Get started in 3 steps')).toBeTruthy();
    expect(within(guide).getByText('Add a product')).toBeTruthy();
    const adminTopic = within(guide).getByText('Admin access');
    const details = adminTopic.closest('details')!;
    expect(details.open).toBe(false);
    fireEvent.click(adminTopic);
    expect(details.open).toBe(true);
    expect(within(details).getByText(/Admin access must be granted/)).toBeTruthy();
    expect(document.activeElement).toBe(within(guide).getByRole('button', { name: 'Close guide' }));
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(open);
    expect(document.body.style.overflow).toBe('');
  });
});
