// @vitest-environment jsdom
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { ExclusiveSession } from './ExclusiveSession';

const originalLocks = Object.getOwnPropertyDescriptor(navigator, 'locks');
afterEach(() => {
  cleanup();
  if (originalLocks) Object.defineProperty(navigator, 'locks', originalLocks);
  else Reflect.deleteProperty(navigator, 'locks');
  vi.restoreAllMocks();
});

function mockLocks() {
  let held = false;
  const waiting: (() => void)[] = [];
  return {
    request: vi.fn(
      (_name: string, options: { signal: AbortSignal }, callback: () => Promise<void>) =>
        new Promise<void>((resolve, reject) => {
          let acquired = false;
          const start = () => {
            if (options.signal.aborted) return;
            acquired = true;
            held = true;
            void callback()
              .then(resolve, reject)
              .finally(() => {
                held = false;
                waiting.shift()?.();
              });
          };
          options.signal.addEventListener('abort', () => {
            if (acquired) return;
            const index = waiting.indexOf(start);
            if (index >= 0) waiting.splice(index, 1);
            reject(new Error('request aborted'));
          });
          if (held) waiting.push(start);
          else start();
        })
    ),
  };
}

describe('single active CountUp tab', () => {
  it('waits without mounting the app, then opens after the first tab releases its lock', async () => {
    const locks = mockLocks();
    Object.defineProperty(navigator, 'locks', { configurable: true, value: locks });
    const first = render(
      <ExclusiveSession>
        <div>First app</div>
      </ExclusiveSession>
    );
    await screen.findByText('First app');
    render(
      <ExclusiveSession>
        <div>Second app</div>
      </ExclusiveSession>
    );
    await screen.findByText('CountUp is open in another tab');
    expect(screen.queryByText('Second app')).toBeNull();
    first.unmount();
    await screen.findByText('Second app');
    expect(locks.request).toHaveBeenCalledTimes(2);
  });

  it('removes a waiting request if that tab closes', async () => {
    Object.defineProperty(navigator, 'locks', { configurable: true, value: mockLocks() });
    const first = render(
      <ExclusiveSession>
        <div>First app</div>
      </ExclusiveSession>
    );
    await screen.findByText('First app');
    const second = render(
      <ExclusiveSession>
        <div>Closed app</div>
      </ExclusiveSession>
    );
    await screen.findByText('CountUp is open in another tab');
    second.unmount();
    first.unmount();
    render(
      <ExclusiveSession>
        <div>Next app</div>
      </ExclusiveSession>
    );
    await screen.findByText('Next app');
    expect(screen.queryByText('Closed app')).toBeNull();
  });

  it('warns explicitly when a browser cannot prevent simultaneous tabs', async () => {
    Object.defineProperty(navigator, 'locks', { configurable: true, value: undefined });
    render(
      <ExclusiveSession>
        <div>App still available</div>
      </ExclusiveSession>
    );
    await waitFor(() => expect(screen.getByRole('alert').textContent).toMatch(/only one tab/i));
    expect(screen.getByText('App still available')).toBeTruthy();
  });
});
