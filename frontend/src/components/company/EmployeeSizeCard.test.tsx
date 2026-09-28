import { render, screen } from '@testing-library/react';
import { EmployeeSizeCard } from './EmployeeSizeCard';
import type { LeadRecord } from '../../types/api';

const company = { id: 'company-1', name: 'Oak Stream Investors', website: 'https://oak.example', investorType: null, location: null } satisfies LeadRecord['company'];

describe('employee size card', () => {
  it('shows the normalized count, range, unknown state, and conflict', () => {
    const { rerender } = render(<EmployeeSizeCard company={{ ...company, companySize: 23, companySizeStatus: 'MATCHED' }} evidence={[{
      id: 'evidence-1',
      evidenceType: 'EMPLOYEE_SIZE',
      sourceUrl: 'https://oak.example/about',
      sourceType: 'official_company',
      evidenceText: 'Oak Stream Investors has 23 employees',
      metadata: { field: 'companySize', value: '23', sourceType: 'official_company', verificationStatus: 'VERIFIED', verified: true },
    }]} conflicts={[]} />);
    expect(screen.getByText('Employee size 23')).toBeInTheDocument();
    expect(screen.getByText('Verification VERIFIED')).toBeInTheDocument();
    expect(screen.getByText('Oak Stream Investors has 23 employees')).toBeInTheDocument();

    rerender(<EmployeeSizeCard company={{ ...company, companySize: '11-50', companySizeStatus: 'MATCHED' }} evidence={[]} conflicts={[]} />);
    expect(screen.getByText('Employee size 11–50')).toBeInTheDocument();

    rerender(<EmployeeSizeCard company={{ ...company, companySize: null, companySizeStatus: 'UNKNOWN' }} evidence={[]} conflicts={[]} />);
    expect(screen.getByText('Employee size UNKNOWN')).toBeInTheDocument();

    rerender(<EmployeeSizeCard company={{ ...company, companySize: 'CONFLICT', companySizeStatus: 'CONFLICT' }} evidence={[]} conflicts={[{
      id: 'conflict-1', fieldName: 'companySize', valueA: '11-50', valueB: '51-200', status: 'CONFLICT',
      sourceTypeA: 'official_company', sourceUrlA: 'https://oak.example/about', sourceTypeB: 'public_directory', sourceUrlB: 'https://directory.example/oak',
      evidenceExcerptA: 'Company size: 11-50 employees', evidenceExcerptB: 'Company size: 51-200 employees',
    }]} />);
    expect(screen.getByText('Employee size CONFLICT')).toBeInTheDocument();
    expect(screen.getByText('Conflict CONFLICT')).toBeInTheDocument();
  });
});
