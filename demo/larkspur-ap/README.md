# Larkspur Garden Co. accounts payable

Larkspur Garden Co. is a fictional chain of nine garden centres. This small Worker decides which supplier
invoices to pay and which to hold for a person, and shows the queue at `/`.

It is the demo app that Steward's agents change. Every vendor, account number and invoice is made up.

| Route | Returns |
| --- | --- |
| `/` | The invoice queue as a page |
| `/api/invoices` | Every invoice with its decision |
| `/api/invoices/:id/decision` | One decision: `pay`, or `hold` with reasons |
| `/api/health` | The commit and branch this deployment was built from |

Rules live in `src/rules.js`; each returns a hold reason or `null`. Run the tests with `npm test`.
