import { buildSystemPrompt } from './handy.prompt';

describe('buildSystemPrompt', () => {
  const now = new Date('2030-03-05T22:30:00Z'); // already Wednesday 6 March in Karachi

  it("states today's date in the customer's timezone", () => {
    const prompt = buildSystemPrompt({
      now,
      timezone: 'Asia/Karachi',
      fullName: null,
      postcode: null,
    });
    expect(prompt).toContain('2030-03-06');
    expect(prompt).toContain('Asia/Karachi');
  });

  it("mentions the customer's name and postcode when known", () => {
    const prompt = buildSystemPrompt({
      now,
      timezone: 'UTC',
      fullName: 'Ava Stone',
      postcode: 'SW1',
    });
    expect(prompt).toContain('Ava Stone');
    expect(prompt).toContain('SW1');
  });

  it('says to ask the customer to add a postcode when it is missing', () => {
    const prompt = buildSystemPrompt({
      now,
      timezone: 'UTC',
      fullName: 'Ava',
      postcode: null,
    });
    expect(prompt).toMatch(/no postcode/i);
  });

  it('forbids claiming a booking is made and demands offset ISO times', () => {
    const prompt = buildSystemPrompt({
      now,
      timezone: 'UTC',
      fullName: null,
      postcode: null,
    });
    expect(prompt).toMatch(/never say a booking is (made|placed)/i);
    expect(prompt).toMatch(/ISO-8601/);
  });
});
