export interface GooglePlacesTextSearchResponse {
  places?: Array<{
    id?: string;
    displayName?: { text?: string };
    formattedAddress?: string;
    addressComponents?: Array<{ longText?: string; shortText?: string; types?: string[] }>;
    websiteUri?: string;
    nationalPhoneNumber?: string;
    primaryTypeDisplayName?: { text?: string };
    googleMapsUri?: string;
    location?: { latitude?: number; longitude?: number };
  }>;
  nextPageToken?: string;
}
