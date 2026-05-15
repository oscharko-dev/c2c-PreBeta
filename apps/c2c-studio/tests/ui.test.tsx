import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { Search } from 'lucide-react';
import { Badge } from '@/components/ui/Badge';
import { CodeSurface } from '@/components/ui/CodeSurface';
import { IconButton } from '@/components/ui/IconButton';
import { MetadataRow } from '@/components/ui/MetadataRow';
import { Panel } from '@/components/ui/Panel';
import { SplitPane } from '@/components/ui/SplitPane';
import { StatusBar } from '@/components/ui/StatusBar';
import { StatusChip } from '@/components/ui/StatusChip';
import { Tabs } from '@/components/ui/Tabs';
import { TreeRow } from '@/components/ui/TreeRow';
import { Truncate } from '@/components/ui/Truncate';

describe('UI Primitives', () => {
  describe('Badge', () => {
    it('covers the variant matrix', () => {
      render(
        <div>
          <Badge variant="default">Default</Badge>
          <Badge variant="success">Success</Badge>
          <Badge variant="warning">Warning</Badge>
          <Badge variant="error">Error</Badge>
          <Badge variant="pending">Pending</Badge>
          <Badge variant="blocked">Blocked</Badge>
          <Badge variant="incomplete">Incomplete</Badge>
          <Badge variant="neutral">Neutral</Badge>
        </div>
      );

      expect(screen.getByText('Default').parentElement).toHaveClass('bg-bg-2');
      expect(screen.getByText('Success').parentElement).toHaveClass('bg-success-soft');
      expect(screen.getByText('Warning').parentElement).toHaveClass('bg-warn-soft');
      expect(screen.getByText('Error').parentElement).toHaveClass('bg-error-soft');
      expect(screen.getByText('Pending').parentElement).toHaveClass('bg-teal-soft');
      expect(screen.getByText('Blocked').parentElement).toHaveClass('bg-orange-soft');
      expect(screen.getByText('Incomplete').parentElement).toHaveClass('bg-violet-soft');
      expect(screen.getByText('Neutral').parentElement).toHaveClass('bg-bg-2');
    });
  });

  describe('StatusChip', () => {
    it('covers the variant matrix', () => {
      const { container } = render(
        <div>
          <StatusChip variant="success" />
          <StatusChip variant="warning" />
          <StatusChip variant="error" />
          <StatusChip variant="pending" />
          <StatusChip variant="blocked" />
          <StatusChip variant="incomplete" />
          <StatusChip variant="neutral" />
          <StatusChip variant="default" />
        </div>
      );

      const chips = Array.from(container.firstElementChild?.children ?? []) as HTMLElement[];
      expect(chips[0]).toHaveClass('bg-success');
      expect(chips[1]).toHaveClass('bg-warn');
      expect(chips[2]).toHaveClass('bg-error');
      expect(chips[3]).toHaveClass('bg-teal', 'animate-pulse');
      expect(chips[4]).toHaveClass('bg-orange');
      expect(chips[5]).toHaveClass('bg-violet');
      expect(chips[6]).toHaveClass('bg-bg-3');
      expect(chips[7]).toHaveClass('bg-bg-3');
    });
  });

  describe('IconButton', () => {
    it('renders correctly and handles clicks', () => {
      const onClick = vi.fn();
      render(<IconButton icon={Search} onClick={onClick} aria-label="Search" />);
      const button = screen.getByRole('button', { name: 'Search' });
      fireEvent.click(button);
      expect(onClick).toHaveBeenCalledTimes(1);
    });

    it('covers active and semantic variants', () => {
      render(
        <div>
          <IconButton icon={Search} aria-label="Default" />
          <IconButton icon={Search} aria-label="Default active" active />
          <IconButton icon={Search} aria-label="Primary" variant="primary" />
          <IconButton icon={Search} aria-label="Danger" variant="danger" />
        </div>
      );

      expect(screen.getByRole('button', { name: 'Default' })).toHaveClass('hover:bg-bg-3');
      expect(screen.getByRole('button', { name: 'Default active' })).toHaveClass('bg-bg-3');
      expect(screen.getByRole('button', { name: 'Primary' })).toHaveClass('border-success/40');
      expect(screen.getByRole('button', { name: 'Danger' })).toHaveClass('border-error/40');
    });
  });

  describe('Panel', () => {
    it('renders header, content, and footer in stable slots', () => {
      const { container } = render(
        <Panel header={<span>Header</span>} footer={<span>Footer</span>}>
          <span>Content</span>
        </Panel>
      );

      expect(screen.getByText('Header')).toBeInTheDocument();
      expect(screen.getByText('Content')).toBeInTheDocument();
      expect(screen.getByText('Footer')).toBeInTheDocument();
      expect(container.firstChild).toHaveClass('flex', 'flex-col');
    });
  });

  describe('Tabs', () => {
    it('implements tab semantics and keyboard navigation', () => {
      const onValueChange = vi.fn();
      render(
        <Tabs
          value="tab2"
          onValueChange={onValueChange}
          tabs={[
            { value: 'tab1', label: 'Tab 1' },
            { value: 'tab2', label: 'Tab 2' },
            { value: 'tab3', label: 'Tab 3' },
          ]}
        />
      );

      const tabs = screen.getAllByRole('tab');
      expect(screen.getByRole('tablist')).toBeInTheDocument();
      expect(tabs[1]).toHaveAttribute('aria-selected', 'true');
      expect(tabs[1]).toHaveAttribute('tabindex', '0');
      expect(tabs[0]).toHaveAttribute('tabindex', '-1');

      fireEvent.keyDown(tabs[1], { key: 'ArrowRight' });
      fireEvent.keyDown(tabs[1], { key: 'ArrowLeft' });
      fireEvent.keyDown(tabs[1], { key: 'Home' });
      fireEvent.keyDown(tabs[1], { key: 'End' });

      expect(onValueChange).toHaveBeenNthCalledWith(1, 'tab3');
      expect(onValueChange).toHaveBeenNthCalledWith(2, 'tab1');
      expect(onValueChange).toHaveBeenNthCalledWith(3, 'tab1');
      expect(onValueChange).toHaveBeenNthCalledWith(4, 'tab3');
    });
  });

  describe('TreeRow', () => {
    it('composes folder toggles with consumer click handlers', () => {
      const onToggle = vi.fn();
      const onClick = vi.fn();

      render(<TreeRow label="src" type="folder" isOpen={false} onToggle={onToggle} onClick={onClick} />);

      const row = screen.getByRole('treeitem', { name: 'src' });
      fireEvent.click(row);

      expect(onToggle).toHaveBeenCalledTimes(1);
      expect(onClick).toHaveBeenCalledTimes(1);
      expect(row).toHaveAttribute('aria-expanded', 'false');
    });

    it('supports keyboard activation and preserves long labels via title', () => {
      const onToggle = vi.fn();
      render(
        <TreeRow
          label="target/java/com/c2c/w0/targetJava/transformation-metadata.json"
          type="folder"
          isOpen
          onToggle={onToggle}
        />
      );

      const row = screen.getByRole('treeitem');
      fireEvent.keyDown(row, { key: 'Enter' });
      fireEvent.keyDown(row, { key: ' ' });

      expect(onToggle).toHaveBeenCalledTimes(2);
      expect(screen.getByTitle('target/java/com/c2c/w0/targetJava/transformation-metadata.json')).toBeInTheDocument();
    });
  });

  describe('Truncate', () => {
    it('truncates long path-like and hash-like strings while preserving the full title', () => {
      render(
        <div>
          <Truncate
            text="target/java/com/c2c/w0/targetJava/transformation-metadata.json"
            maxLength={18}
            position="middle"
          />
          <Truncate text="cb4ddf023b0f57e79d63de91205f4fe31f6d6bf0" maxLength={14} position="middle" />
        </div>
      );

      expect(screen.getByTitle('target/java/com/c2c/w0/targetJava/transformation-metadata.json')).toHaveTextContent(
        'target/ja...data.json'
      );
      expect(screen.getByTitle('cb4ddf023b0f57e79d63de91205f4fe31f6d6bf0')).toHaveTextContent('cb4ddf0...f6d6bf0');
    });
  });

  describe('Layout primitives', () => {
    it('renders split panes, metadata rows, code surfaces, and status bars', () => {
      render(
        <div>
          <SplitPane
            left={<div>Left pane</div>}
            right={<div>Right pane</div>}
            leftLabel="Source"
            rightLabel="Target"
          />
          <MetadataRow
            items={[
              { label: 'source', value: 'corpus/synthetic/branch-account-guard.cbl', truncate: 'middle' },
              { label: 'hash', value: 'cb4ddf023b0f57e79d63de91205f4fe31f6d6bf0', truncate: 'middle', tone: 'success' },
            ]}
          />
          <CodeSurface
            label="Generated Java"
            lines={[
              { content: 'package com.c2c.w0.targetJava;' },
              { content: 'public final class ServiceApp {}', active: true },
            ]}
          />
          <StatusBar
            breadcrumbs={['c2c-PreBeta', 'corpus', 'branch-account-guard.cbl']}
            items={[{ label: 'build', value: 'match', valueVariant: 'success' }]}
          />
        </div>
      );

      expect(screen.getByLabelText('Source')).toBeInTheDocument();
      expect(screen.getByLabelText('Target')).toBeInTheDocument();
      expect(screen.getByText('source')).toBeInTheDocument();
      expect(screen.getByLabelText('Generated Java')).toBeInTheDocument();
      expect(screen.getByText('build')).toBeInTheDocument();
      expect(screen.getByText('match')).toBeInTheDocument();
    });
  });
});
