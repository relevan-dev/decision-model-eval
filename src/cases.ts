import type { IndexMapping, PhoneticConfig } from "./mapping";

// Labelled cases: ten realistic indexes, with the phonetic config a search
// engineer would set for each. The eval scores against the
// label. Each label is a hypothesis until retrieval tests with spoken-name
// queries and false positives confirm it.
//
// Two rules decide every label, and the comment on each case says which one
// applies where the call is not obvious:
//
// 1. Enable phonetic matching on a field that holds names people say the same
//    way but spell differently — people, companies, places, brands. Leave it
//    off for prose, controlled vocabularies, codes, and addresses, where
//    sound-alike matches only add wrong results.
// 2. Choose `double_metaphone`, which also handles English names. Choose
//    another encoder only for a stated compatibility requirement, or for a
//    measured improvement on representative queries.

/** One index, its mapping, sample values per field, and the correct config. */
export interface EvalCase {
  indexName: string;
  /** What the index holds, as a customer would describe it. */
  description: string;
  mapping: IndexMapping;
  samples: Record<string, readonly string[]>;
  /** The config a search engineer would write for this index. */
  expected: PhoneticConfig;
}

export const EVAL_CASES: readonly EvalCase[] = [
  {
    indexName: "recruiter-candidates",
    description:
      "Candidate records for an international recruiting agency. Recruiters type a " +
      "name they heard on a call and expect to find the candidate.",
    mapping: {
      fields: {
        candidateName: { use: ["searchable", "autocompletable"], kind: "text", language: "none" },
        currentEmployer: { use: ["searchable", "filterable"], kind: "text", language: "none" },
        summary: { use: ["searchable", "highlightable"], kind: "text" },
        email: { use: ["searchable"], kind: "text", language: "none" },
        yearsExperience: { use: ["filterable", "sortable"], kind: "number" },
      },
    },
    samples: {
      candidateName: ["Siobhán O'Carroll", "Krzysztof Nowak", "Jonathan Meyer"],
      currentEmployer: ["Kuehne + Nagel", "Schwarzkopf GmbH", "Accenture"],
      summary: ["Backend engineer with eight years on payment systems and a focus on reliability."],
      email: ["s.ocarroll@example.com", "k.nowak@example.net"],
      yearsExperience: ["8", "12"],
    },
    // `summary` is prose and `email` is an address people copy rather than
    // hear, so neither gets the subfield.
    expected: {
      fields: {
        candidateName: { encoder: "double_metaphone" },
        currentEmployer: { encoder: "double_metaphone" },
      },
    },
  },
  {
    indexName: "legacy-membership-roll",
    description:
      "Member roll migrated off a mainframe. The index must use phonetic codes " +
      "compatible with the existing SOUNDEX index the back office still runs.",
    mapping: {
      fields: {
        surname: { use: ["searchable", "sortable"], kind: "text", language: "none" },
        forename: { use: ["searchable"], kind: "text", language: "none" },
        memberNumber: { use: ["searchable", "filterable"], kind: "id" },
        notes: { use: ["searchable"], kind: "text" },
      },
    },
    samples: {
      surname: ["Smythe", "Carrington", "Attwood"],
      forename: ["Margaret", "Ethel", "Frederick"],
      memberNumber: ["MBR-0043112", "MBR-0043113"],
      notes: ["Renewed by post in March. Gift aid form on file."],
    },
    // The stated compatibility requirement is the only reason to pick `soundex` over
    // `double_metaphone`; without it these fields would take the default.
    expected: {
      fields: {
        surname: { encoder: "soundex" },
        forename: { encoder: "soundex" },
      },
    },
  },
  {
    indexName: "ecommerce-products",
    description:
      "Product catalogue for a consumer electronics retailer. Shoppers search by " +
      "what they want and by the maker's name.",
    mapping: {
      fields: {
        title: { use: ["searchable", "autocompletable", "highlightable"], kind: "text" },
        brand: { use: ["searchable", "filterable"], kind: "text", language: "none" },
        description: { use: ["searchable", "highlightable"], kind: "text" },
        sku: { use: ["searchable", "filterable"], kind: "id" },
        price: { use: ["filterable", "sortable"], kind: "number" },
      },
    },
    samples: {
      title: ["Wireless noise cancelling over-ear headphones", "65-inch 4K smart television"],
      brand: ["Sennheiser", "Huawei", "Bang & Olufsen"],
      description: ["Thirty hours of battery life and a folding travel case."],
      sku: ["SKU-88213-BLK", "SKU-41190-SLV"],
      price: ["249.00", "899.00"],
    },
    // `title` and `description` are descriptive words, not names: a phonetic
    // clause over them matches on sound across the whole catalogue.
    expected: { fields: { brand: { encoder: "double_metaphone" } } },
  },
  {
    indexName: "medical-providers",
    description:
      "Directory of clinics and doctors across the United States. Patients search " +
      "for a doctor whose name they were told over the phone.",
    mapping: {
      fields: {
        providerName: { use: ["searchable", "autocompletable"], kind: "text", language: "none" },
        clinicName: { use: ["searchable"], kind: "text", language: "none" },
        city: { use: ["searchable", "filterable"], kind: "text", language: "none" },
        specialty: { use: ["searchable", "filterable"], kind: "text" },
        npiNumber: { use: ["filterable"], kind: "id" },
      },
    },
    samples: {
      providerName: ["Dr. Rajesh Venkataraman", "Dr. Aoife Ní Bhriain", "Dr. Michael Kowalczyk"],
      clinicName: ["Cedars-Sinai Medical Group", "Ochsner Baptist"],
      city: ["Albuquerque", "Poughkeepsie", "La Jolla"],
      specialty: ["cardiology", "paediatric oncology", "general practice"],
      npiNumber: ["1234567893"],
    },
    // `specialty` is a controlled vocabulary the patient picks from a list.
    expected: {
      fields: {
        providerName: { encoder: "double_metaphone" },
        clinicName: { encoder: "double_metaphone" },
        city: { encoder: "double_metaphone" },
      },
    },
  },
  {
    indexName: "academic-papers",
    description:
      "Papers from an international physics repository. Readers search for an " +
      "author whose name they heard at a conference.",
    mapping: {
      fields: {
        authorName: { use: ["searchable", "filterable"], kind: "text", language: "none" },
        title: { use: ["searchable", "highlightable"], kind: "text" },
        abstract: { use: ["searchable", "highlightable"], kind: "text" },
        keywords: { use: ["searchable", "aggregatable"], kind: "text" },
        doi: { use: ["searchable", "filterable"], kind: "id" },
      },
    },
    samples: {
      authorName: ["Nandakishor Muraleedharan", "Zhu Xiaoming", "Élodie Beaumont"],
      title: ["Non-autoregressive decision heads for typed inference"],
      abstract: ["We present a single forward pass method for typed decisions over text."],
      keywords: ["calibration", "classification", "inference"],
      doi: ["10.1000/xyz123"],
    },
    // `keywords` is a controlled vocabulary; `title` and `abstract` are prose.
    expected: { fields: { authorName: { encoder: "double_metaphone" } } },
  },
  {
    indexName: "support-tickets",
    description:
      "Support tickets for a software product. Agents search the ticket text and " +
      "sometimes look up every ticket a named customer raised.",
    mapping: {
      fields: {
        subject: { use: ["searchable", "highlightable"], kind: "text" },
        body: { use: ["searchable", "highlightable"], kind: "text" },
        reporterName: { use: ["searchable", "filterable"], kind: "text", language: "none" },
        ticketId: { use: ["searchable", "filterable"], kind: "id" },
      },
    },
    samples: {
      subject: ["Duplicate charge on invoice 4411", "Cannot reset my password"],
      body: ["We were billed twice for March. Please refund the duplicate today."],
      reporterName: ["Grzegorz Brzęczyszczykiewicz", "Mary Byrne", "Yusuf Şahin"],
      ticketId: ["TKT-88213"],
    },
    expected: { fields: { reporterName: { encoder: "double_metaphone" } } },
  },
  {
    indexName: "english-parish-registers",
    description:
      "Baptism and burial records from English parishes between 1600 and 1900. " +
      "Every name in the register is English, and the clerks spelled them by ear.",
    mapping: {
      fields: {
        surname: { use: ["searchable", "sortable"], kind: "text", language: "none" },
        givenName: { use: ["searchable"], kind: "text", language: "none" },
        parish: { use: ["searchable", "filterable"], kind: "text", language: "none" },
        occupation: { use: ["searchable", "aggregatable"], kind: "text" },
        year: { use: ["filterable", "sortable"], kind: "number" },
      },
    },
    samples: {
      surname: ["Thackeray", "Wyght", "Ffoulkes"],
      givenName: ["Elizabeth", "Thomas", "Jayne"],
      parish: ["Cirencester", "Bicester", "Wymondham"],
      occupation: ["labourer", "wheelwright", "yeoman"],
      year: ["1687", "1812"],
    },
    // English-only names are not a reason to leave the default: no
    // compatibility requirement or measured improvement names another encoder.
    expected: {
      fields: {
        surname: { encoder: "double_metaphone" },
        givenName: { encoder: "double_metaphone" },
        parish: { encoder: "double_metaphone" },
      },
    },
  },
  {
    indexName: "restaurant-listings",
    description:
      "Restaurant listings for a city guide. Diners search for a place a friend " +
      "recommended out loud, so they rarely have the spelling.",
    mapping: {
      fields: {
        restaurantName: { use: ["searchable", "autocompletable"], kind: "text", language: "none" },
        neighbourhood: { use: ["searchable", "filterable"], kind: "text", language: "none" },
        cuisine: { use: ["searchable", "filterable", "aggregatable"], kind: "text" },
        phone: { use: ["filterable"], kind: "text", language: "none" },
      },
    },
    samples: {
      restaurantName: ["Pizzeria Bianco", "Le Bernardin", "Sqirl"],
      neighbourhood: ["Kreuzberg", "Shoreditch", "Ravenswood"],
      cuisine: ["italian", "vietnamese", "seafood"],
      phone: ["+1 212 554 1515"],
    },
    // `cuisine` is a facet the diner clicks, not a name they mishear.
    expected: {
      fields: {
        restaurantName: { encoder: "double_metaphone" },
        neighbourhood: { encoder: "double_metaphone" },
      },
    },
  },
  {
    indexName: "application-logs",
    description:
      "Runtime logs from a payments service. Engineers search for the text of an " +
      "error they already saw in an alert, so a match must be exact.",
    mapping: {
      fields: {
        message: { use: ["searchable", "highlightable"], kind: "text" },
        service: { use: ["searchable", "aggregatable"], kind: "text" },
        level: { use: ["searchable", "aggregatable"], kind: "text" },
        stackTrace: { use: ["searchable", "highlightable"], kind: "text" },
      },
    },
    samples: {
      message: ["Connection refused to upstream ledger on retry 3"],
      service: ["payments-api", "ledger-worker", "webhook-dispatcher"],
      level: ["error", "warn", "info"],
      stackTrace: ["at LedgerClient.post (ledger-client.ts:112)"],
    },
    // No field holds a name, and a sound-alike match hides the exact line.
    expected: { fields: {} },
  },
  {
    indexName: "api-error-codes",
    description:
      "The reference list of error codes the public API returns. Developers paste " +
      "a code from a response body and expect the one page that explains it.",
    mapping: {
      fields: {
        code: { use: ["searchable", "filterable"], kind: "text" },
        summary: { use: ["searchable", "highlightable"], kind: "text" },
        resolution: { use: ["searchable", "highlightable"], kind: "text" },
      },
    },
    samples: {
      code: ["RATE_LIMITED", "INVALID_CURSOR", "INDEX_NOT_READY"],
      summary: ["The request exceeded the organisation rate limit."],
      resolution: ["Retry after the interval in the Retry-After header."],
    },
    // `code` is an identifier the developer copies, so a near match is wrong.
    expected: { fields: {} },
  },
];

/** Looks up one case by index name, naming the alternatives when it is absent. */
export function evalCaseByName(indexName: string): EvalCase {
  const found = EVAL_CASES.find((evalCase) => evalCase.indexName === indexName);
  if (!found) {
    const names = EVAL_CASES.map((evalCase) => evalCase.indexName).join(", ");
    throw new Error(`Unknown index "${indexName}". Available: ${names}.`);
  }
  return found;
}
