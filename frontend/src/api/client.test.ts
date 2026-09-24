import { readErrorMessage } from './client';

describe('API error handling', () => {
  it('hides internal details and maps status codes', () => {
    expect(readErrorMessage(500, { message: 'password leaked at postgres redis stack' })).toBe('Unable to complete the request. Please try again.');
    expect(readErrorMessage(404, { message: 'Search not found' })).toBe('Search not found');
    expect(readErrorMessage(401, { message: 'Invalid email or password' })).toBe('Invalid email or password');
    expect(readErrorMessage(429, { message: ['Too many requests'] })).toBe('Too many requests');
    expect(readErrorMessage(403, { message: 'Forbidden' })).toBe('Forbidden');
    expect(readErrorMessage(409, { message: 'Already running' })).toBe('Already running');
    expect(readErrorMessage(422, { message: 'Invalid field' })).toBe('Invalid field');
    expect(readErrorMessage(400, { message: 'api_key=hidden' })).toBe('Some fields need to be corrected.');
  });
});
