**Handy AI**

Phase One | Software Development Agreement

_AI-Powered Lifestyle and Home Services Platform_

US Launch | iOS and Android |

# **1\. Project Overview**

This agreement covers the design and development of Handy AI Phase One: a production-ready, AI-powered home services platform for the London market. Phase One delivers the complete core Handy experience including the conversational AI interface, provider management, booking engine, Stripe payment processing, and admin dashboard.

| **Parameter**          | **Detail**                                                                                      |
| ---------------------- | ----------------------------------------------------------------------------------------------- |
| **Platform**           | iOS and Android via React Native (single codebase)                                              |
| **Target Market**      | US, Start with a specific State                                                                 |
| **Services at Launch** | Cleaning, Handyman, Electrical, Plumbing                                                        |
| **AI Interface**       | GPT-4 API for conversational booking, intent extraction and plan generation                     |
| **Payments**           | All payments processed in-app via Stripe. No cash and no external transfers permitted.          |
| **Usage Controls**     | AI usage threshold enforced per time window to prevent over-consumption. No subscription tiers. |
| **Admin**              | Web-based admin dashboard for internal team use                                                 |

# **2\. Services in Scope**

The following four services are included in Phase One. All services are booked exclusively through Handy's conversational AI interface with no browsing menus or forms involved.

| **Service**    | **Sub-services Included**                                                           | **Available To** |
| -------------- | ----------------------------------------------------------------------------------- | ---------------- |
| **Cleaning**   | Regular home clean, deep clean, one-off clean, end of tenancy clean                 | All users        |
| **Handyman**   | Furniture assembly, TV and shelf mounting, minor repairs, basic maintenance         | All users        |
| **Electrical** | Light fixture installation, socket repairs, minor wiring fixes, switch replacements | All users        |
| **Plumbing**   | Leak repairs, blocked drains, tap replacement, toilet repairs                       | All users        |

_The following are out of scope for Phase One and will be addressed in future phases: dog walking, personal shoppers, drivers, private chefs, event services, wine connoisseurs, security services, grocery shopping and dry cleaning collection._

# **3\. AI Conversational Interface**

The Handy AI interface is the core product experience. All booking interactions occur through conversation. The interface is designed to behave like a real personal assistant: calm, efficient and precise.

| **Feature**                   | **Description**                                                                                                              |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| **Natural Language Booking**  | Handy extracts service type, date, time and location from free-text input with no form filling required from the user        |
| **Contextual Understanding**  | Handy understands relative timing such as 'tomorrow morning', 'next Friday' or 'sometime this week'                          |
| **Minimal Clarification**     | Handy asks only what it cannot infer, with a maximum of one or two follow-up questions per request                           |
| **Booking Plan Generation**   | Handy presents a full plan showing provider, time, duration and cost before any booking action is taken                      |
| **User Confirmation Flow**    | User confirms, adjusts or cancels Handy's proposed plan within the chat before anything is committed                         |
| **Trusted Provider Priority** | Handy automatically attempts to match the user's trusted provider before suggesting others                                   |
| **Household Notes Surfacing** | Stored access instructions, entry codes and key arrangements are shared with the assigned provider on each job               |
| **Handy Personality**         | Defined by a structured system prompt covering tone, language and guardrails. Calm, warm and refined across all sessions.    |
| **Usage Threshold**           | A per-window usage limit is enforced on the AI layer to prevent over-consumption. No subscription or tier logic is required. |

# **4\. User-Facing Features**

## **4.1 Onboarding**

| **Feature**         | **Description**                                                                                                                                                                                                            |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Sign Up**         | Email or phone number, verified via one-time passcode (OTP)                                                                                                                                                                |
| **User Profile**    | Name, address, postcode and profile photo                                                                                                                                                                                  |
| **Household Notes** | User enters access instructions, entry codes and key arrangements. Stored permanently and surfaced on each booking.                                                                                                        |
| **Payment Setup**   | User saves a card once during onboarding. On each subsequent booking, the user is directed to Stripe Checkout where the saved card is pre-selected. If no saved card is found, the user enters card details at that point. |

## **4.2 Core App Features**

| **Feature**                  | **Description**                                                                                                                                       |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Handy Chat Interface**     | The app opens directly to the Handy chat. No home screen menus and no service browsing.                                                               |
| **Booking History**          | Full booking history visible to all users                                                                                                             |
| **Trusted Provider Saving**  | After any completed job, the user can mark the provider as trusted with a single tap                                                                  |
| **Trusted Provider Memory**  | Handy remembers trusted providers and prioritises them on future matching                                                                             |
| **Schedule View**            | All upcoming bookings shown in a clean timeline view                                                                                                  |
| **Edit and Cancel Bookings** | User can modify or cancel any upcoming booking from the schedule view                                                                                 |
| **In-App Messaging**         | Direct messaging between user and assigned provider through Handy. No external contact details are shared.                                            |
| **Push Notifications**       | Sent for: booking confirmed, provider on the way, job marked complete, and upcoming booking reminders                                                 |
| **Contact Support**          | A contact support form is available for users to submit queries directly to the team by email. There is no in-app support ticket system in Phase One. |

# **5\. Provider-Facing Features**

Providers interact with Handy through a dedicated section of the mobile app. The experience is designed to be low friction as providers are working professionals who need fast and clear screens.

| **Feature**                   | **Description**                                                                                                                                                     |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Provider Onboarding**       | Multi-step form covering personal details, service categories, postcode coverage and availability                                                                   |
| **Document Upload**           | Government ID, right-to-work proof, public liability insurance certificate and references. All reviewed manually by the Handy team before any provider is approved. |
| **Profile Management**        | Provider manages their bio, skills, availability and service area                                                                                                   |
| **Availability Calendar**     | Provider sets working days and hours. Handy only offers bookings within these windows.                                                                              |
| **Job Request Inbox**         | Incoming job requests displayed with full booking details. Provider accepts or declines.                                                                            |
| **Access Instructions**       | Household notes, key arrangements and entry codes surfaced automatically for each job                                                                               |
| **Job Completion Trigger**    | Provider marks job complete. This triggers automatic payment release from hold to the provider's Stripe account.                                                    |
| **Earnings Dashboard**        | Provider sees completed jobs, pending payouts and total earned to date                                                                                              |
| **In-App Messaging**          | Provider messages the user through Handy with no external contact details shared                                                                                    |
| **Stripe Connect Onboarding** | Provider sets up a Stripe Express account as part of onboarding to receive payouts                                                                                  |

## **5.1 Provider Vetting**

All provider applications are reviewed manually by the Handy team. No provider becomes visible on the platform without explicit team approval. The following are required before approval is granted:

- Government-issued photo ID
- Right to work in the UK (visa, residency document or UK passport)
- Minimum one client reference with name and contact details
- Valid and current public liability insurance certificate
- Clear profile photo reviewed and approved by the team

# **6\. Payment Architecture**

All payments are processed exclusively through Handy via Stripe. There is no cash, no direct bank transfer and no payment made outside the app under any circumstances.

## **6.1 Payment Flow for All Services**

The following flow applies to all fixed-price services in Phase One:

- User reviews and approves Handy's booking plan within the chat
- User is directed to Stripe Checkout. If a saved card exists it is pre-selected; otherwise the user enters card details.
- Payment is charged at the point of booking confirmation and held by Stripe
- Provider receives the booking and accepts or declines
- Provider completes the job and marks it as complete in the app
- Stripe releases the held payment. A 20% platform commission is deducted automatically via Stripe Connect.
- The remaining amount is transferred to the provider's Stripe Express account
- User receives an in-app receipt and the provider receives earnings confirmation

| **Parameter**           | **Detail**                                                                                                              |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| **Platform Commission** | 20% deducted from each transaction via Stripe Connect (to be confirmed in writing before development begins)            |
| **Payment Processor**   | Stripe Connect with Stripe Checkout                                                                                     |
| **Charge Timing**       | Payment charged at booking confirmation and held until job is marked complete                                           |
| **Provider Payout**     | Released automatically via Stripe after provider marks job complete                                                     |
| **Cash**                | Not accepted under any circumstances                                                                                    |
| **Receipts**            | In-app receipt issued to user for every completed transaction                                                           |
| **Refunds**             | Handled manually by the Handy team via the Stripe dashboard. There is no refund option in the admin panel in Phase One. |

# **7\. Admin Dashboard**

A web-based admin dashboard gives the Handy team the tools to operate the platform from day one. It is internal-facing only and is not accessible to users or providers.

| **Feature**                          | **Description**                                                                                     |
| ------------------------------------ | --------------------------------------------------------------------------------------------------- |
| **Provider Applications**            | View all pending provider applications with uploaded documents. Approve or reject each application. |
| **Provider Management**              | View, enable, disable or remove any active provider on the platform                                 |
| **Booking Overview**                 | View all active, upcoming and completed bookings in real time                                       |
| **Manual Booking Intervention**      | Reassign a provider to a booking if the original provider cancels or becomes unavailable            |
| **User Management**                  | View registered users and their booking history                                                     |
| **Payment and Transaction Overview** | View all transactions with status, amount, platform commission and provider payout details          |
| **Platform Stats**                   | High-level dashboard showing total users, total providers, active bookings and daily revenue        |

_Refunds are handled manually by the team via the Stripe dashboard. Support requests submitted by users through the contact form are routed directly to email and are not tracked inside the admin dashboard in Phase One._

# **8\. Technical Architecture**

| **Component**          | **Technology**                                                                                         |
| ---------------------- | ------------------------------------------------------------------------------------------------------ |
| **Mobile App**         | React Native (single codebase for iOS and Android)                                                     |
| **Admin Dashboard**    | React.js (internal web dashboard)                                                                      |
| **AI Layer**           | GPT-4 API via OpenAI (conversational interface, intent extraction, plan generation, Handy personality) |
| **Backend**            | Node.js with Express (REST API)                                                                        |
| **Database**           | PostgreSQL (users, providers, bookings, payments, trusted relationships, household notes)              |
| **Push Notifications** | Firebase Cloud Messaging (real-time booking status and alerts)                                         |
| **Payments**           | Stripe Connect with Stripe Checkout (marketplace flow, payment hold and release, commission deduction) |
| **File Storage**       | AWS S3 or Cloudinary (provider documents and profile photos)                                           |
| **Email and Support**  | SendGrid (transactional emails); contact support form routes user submissions directly to email        |
| **Hosting**            | AWS (backend and web infrastructure)                                                                   |

# **9\. Explicitly Out of Scope**

The following are not included in Phase One. They must not be introduced or partially built during this engagement. Any request to include these will be treated as a change order and scoped separately.

- Grocery shopping and dry cleaning collection services
- Dog walking, personal shoppers, drivers, private chefs, event services, wine connoisseurs and security services
- Voice input to Handy
- Subscription or premium tier model for users
- Recurring bookings and multi-service planning within a single conversation session
- Web app portal for users or providers
- Automated provider vetting
- Handy proactive suggestions and AI-driven usage pattern learning
- Multi-property management (one household per user account in Phase One)
- In-app refund flow in the admin panel
- In-app support ticket system or complaint monitoring in the admin panel
- Tier management, usage tracking visible to the user, or any subscription billing