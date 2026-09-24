import type { CompanyLike, ContactDiscoveryContext, ContactDiscoveryResult } from '../types/contact.types';

export const CONTACT_DISCOVERY_PROVIDER = Symbol('CONTACT_DISCOVERY_PROVIDER');

export interface ContactDiscoveryProvider {
  discover(company: CompanyLike, context: ContactDiscoveryContext): Promise<ContactDiscoveryResult>;
}
