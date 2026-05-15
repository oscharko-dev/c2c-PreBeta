import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { GeneratedProjectTree } from '@/components/generated/GeneratedProjectTree';

describe('GeneratedProjectTree', () => {
  it('supports nested folder navigation and file activation with the keyboard', async () => {
    const onSelectFile = vi.fn();
    const tree = [
      {
        name: 'src',
        path: 'src',
        type: 'directory',
        children: [
          {
            name: 'main',
            path: 'src/main',
            type: 'directory',
            children: [
              {
                name: 'App.java',
                path: 'src/main/App.java',
                type: 'file',
                children: [],
              },
            ],
          },
        ],
      },
      {
        name: 'README.md',
        path: 'README.md',
        type: 'file',
        children: [],
      },
    ];

    render(
      <GeneratedProjectTree
        tree={tree}
        selectedPath={null}
        onSelectFile={onSelectFile}
        unavailableFiles={new Set()}
      />,
    );

    const src = screen.getByRole('treeitem', { name: 'src' });
    const main = screen.getByRole('treeitem', { name: 'main' });
    const app = screen.getByRole('treeitem', { name: 'App.java' });
    const readme = screen.getByRole('treeitem', { name: 'README.md' });

    src.focus();
    expect(src).toHaveFocus();

    fireEvent.keyDown(src, { key: 'ArrowRight' });
    await waitFor(() => expect(main).toHaveFocus());

    fireEvent.keyDown(main, { key: 'ArrowDown' });
    await waitFor(() => expect(app).toHaveFocus());

    fireEvent.keyDown(app, { key: 'Enter' });
    expect(onSelectFile).toHaveBeenCalledWith('src/main/App.java');

    fireEvent.keyDown(app, { key: 'ArrowLeft' });
    await waitFor(() => expect(main).toHaveFocus());

    fireEvent.keyDown(main, { key: 'ArrowLeft' });
    await waitFor(() => expect(main).toHaveFocus());
    expect(screen.queryByRole('treeitem', { name: 'App.java' })).toBeNull();

    fireEvent.keyDown(main, { key: 'ArrowRight' });
    await waitFor(() => expect(screen.getByRole('treeitem', { name: 'App.java' })).toBeInTheDocument());

    fireEvent.keyDown(readme, { key: 'End' });
    await waitFor(() => expect(readme).toHaveFocus());

    fireEvent.keyDown(readme, { key: 'Home' });
    await waitFor(() => expect(src).toHaveFocus());
  });
});
