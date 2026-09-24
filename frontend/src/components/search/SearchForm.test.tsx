import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SearchForm } from './SearchForm';

describe('search form validation', () => {
  it('requires a name and prompt before submission', async () => {
    const onSubmit = vi.fn();
    render(<SearchForm busy={false} onSubmit={onSubmit} onPreview={vi.fn()} />);
    await userEvent.click(screen.getByRole('button', { name: 'Start search' }));
    expect(screen.getByText('Enter a search name.')).toBeInTheDocument();
    expect(screen.getByText('Enter a search prompt.')).toBeInTheDocument();
    expect(onSubmit).not.toHaveBeenCalled();
  });
});
