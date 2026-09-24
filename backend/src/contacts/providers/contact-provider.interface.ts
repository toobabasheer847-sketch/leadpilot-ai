import { CompanyLike, ContactDiscoveryContext, ContactDiscoveryResult } from '../types/contact.types';

export interface ContactDiscoveryProvider {
  discover(company: CompanyLike, context: ContactDiscoveryContext): Promise<ContactDiscoveryResult>;
}
