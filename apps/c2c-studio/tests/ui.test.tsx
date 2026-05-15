import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { Badge } from '@/components/ui/Badge';
import { StatusChip } from '@/components/ui/StatusChip';
import { IconButton } from '@/components/ui/IconButton';
import { Panel } from '@/components/ui/Panel';
import { Tabs } from '@/components/ui/Tabs';
import { TreeRow } from '@/components/ui/TreeRow';
import { Truncate } from '@/components/ui/Truncate';
import { Search } from 'lucide-react';

describe('UI Primitives', () => {
  describe('Badge', () => {
    it('renders default variant correctly', () => {
      render(<Badge>Default Badge</Badge>);
      expect(screen.getByText('Default Badge')).toBeInTheDocument();
      // Should have neutral classes
      const badge = screen.getByText('Default Badge').parentElement;
      expect(badge).toHaveClass('bg-bg-2');
    });

    it('renders success variant correctly', () => {
      render(<Badge variant="success">Success Badge</Badge>);
      const badge = screen.getByText('Success Badge').parentElement;
      expect(badge).toHaveClass('bg-success-soft', 'text-success');
    });
  });

  describe('StatusChip', () => {
    it('renders pending variant with pulse', () => {
      const { container } = render(<StatusChip variant="pending" />);
      const chip = container.firstChild as HTMLElement;
      expect(chip).toHaveClass('bg-teal', 'animate-pulse');
    });

    it('renders error variant', () => {
      const { container } = render(<StatusChip variant="error" />);
      const chip = container.firstChild as HTMLElement;
      expect(chip).toHaveClass('bg-error');
    });
  });

  describe('IconButton', () => {
    it('renders correctly and handles clicks', () => {
      const onClick = vi.fn();
      render(<IconButton icon={Search} onClick={onClick} aria-label="Search" />);
      const btn = screen.getByLabelText('Search');
      fireEvent.click(btn);
      expect(onClick).toHaveBeenCalledTimes(1);
    });

    it('applies keyboard focus styles', () => {
      render(<IconButton icon={Search} aria-label="Search" />);
      const btn = screen.getByLabelText('Search');
      expect(btn).toHaveClass('focus-visible:ring-1', 'focus-visible:ring-accent');
    });
  });

  describe('Panel', () => {
    it('renders header, content, and footer', () => {
      render(
        <Panel header={<span>Header</span>} footer={<span>Footer</span>}>
          <span>Content</span>
        </Panel>
      );
      expect(screen.getByText('Header')).toBeInTheDocument();
      expect(screen.getByText('Content')).toBeInTheDocument();
      expect(screen.getByText('Footer')).toBeInTheDocument();
    });
  });

  describe('Tabs', () => {
    it('switches tabs on click', () => {
      const onValueChange = vi.fn();
      render(
        <Tabs
          value="tab1"
          onValueChange={onValueChange}
          tabs={[
            { value: 'tab1', label: 'Tab 1' },
            { value: 'tab2', label: 'Tab 2' },
          ]}
        />
      );
      const tab2 = screen.getByText('Tab 2');
      fireEvent.click(tab2);
      expect(onValueChange).toHaveBeenCalledWith('tab2');
    });

    it('applies keyboard focus styles to tabs', () => {
      render(
        <Tabs
          value="tab1"
          onValueChange={vi.fn()}
          tabs={[{ value: 'tab1', label: 'Tab 1' }]}
        />
      );
      const tab = screen.getByText('Tab 1');
      expect(tab).toHaveClass('focus-visible:ring-1', 'focus-visible:ring-accent');
    });
  });

  describe('TreeRow', () => {
    it('renders file row', () => {
      render(<TreeRow label="index.ts" type="file" />);
      expect(screen.getByText('index.ts')).toBeInTheDocument();
    });

    it('renders folder row and handles toggle', () => {
      const onToggle = vi.fn();
      render(<TreeRow label="src" type="folder" isOpen={false} onToggle={onToggle} />);
      const row = screen.getByText('src').parentElement;
      fireEvent.click(row!);
      expect(onToggle).toHaveBeenCalledTimes(1);
    });
    
    it('renders with status chip', () => {
      const { container } = render(<TreeRow label="main.ts" type="file" statusVariant="error" />);
      // We expect the chip to have bg-error
      const chip = container.querySelector('.bg-error');
      expect(chip).toBeInTheDocument();
    });
  });

  describe('Truncate', () => {
    it('truncates at the end by default', () => {
      render(<Truncate text="this_is_a_very_long_string_that_needs_truncation" maxLength={10} />);
      expect(screen.getByText('this_is_a_...')).toBeInTheDocument();
    });

    it('truncates in the middle when specified', () => {
      render(<Truncate text="abcdefghijklmno" maxLength={10} position="middle" />);
      expect(screen.getByText('abcde...klmno')).toBeInTheDocument();
    });
  });
});
