const crypto = require("crypto");
const fs = require("fs/promises");
const path = require("path");

const dataDirectory = path.resolve(
  process.env.PAYMENT_DATA_DIR || path.join(__dirname, ".payment-data")
);
const submissionsFile = path.join(dataDirectory, "submissions.json");
let writes = Promise.resolve();

async function readSubmissions() {
  try {
    const contents = await fs.readFile(submissionsFile, "utf8");
    const submissions = JSON.parse(contents);
    if (!Array.isArray(submissions)) {
      throw new Error("Payment submission data has an invalid format.");
    }
    return submissions;
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}

function withWriteLock(operation) {
  const result = writes.then(operation, operation);
  writes = result.catch(() => {});
  return result;
}

async function addSubmission(submission) {
  return withWriteLock(async () => {
    const submissions = await readSubmissions();
    submissions.push(submission);
    await fs.mkdir(dataDirectory, { recursive: true, mode: 0o700 });
    const temporaryFile = `${submissionsFile}.${process.pid}.${crypto.randomUUID()}.tmp`;
    try {
      await fs.writeFile(temporaryFile, JSON.stringify(submissions), { mode: 0o600 });
      await fs.rename(temporaryFile, submissionsFile);
    } catch (error) {
      await fs.rm(temporaryFile, { force: true });
      throw error;
    }
  });
}

async function updateSubmission(reference, update) {
  return withWriteLock(async () => {
    const submissions = await readSubmissions();
    const index = submissions.findIndex((submission) => submission.reference === reference);
    if (index === -1) return null;
    const updated = update(submissions[index]);
    if (!updated) return null;
    submissions[index] = updated;
    await fs.mkdir(dataDirectory, { recursive: true, mode: 0o700 });
    const temporaryFile = `${submissionsFile}.${process.pid}.${crypto.randomUUID()}.tmp`;
    try {
      await fs.writeFile(temporaryFile, JSON.stringify(submissions), { mode: 0o600 });
      await fs.rename(temporaryFile, submissionsFile);
    } catch (error) {
      await fs.rm(temporaryFile, { force: true });
      throw error;
    }
    return updated;
  });
}

async function getSubmissions(discordUserId) {
  const submissions = await readSubmissions();
  return submissions
    .filter((submission) => submission.discordUserId === discordUserId)
    .sort((left, right) => right.submittedAt - left.submittedAt)
    .map(({ discordUserId: _discordUserId, reviewTokenHash: _reviewTokenHash, ...submission }) => {
      if (submission.status === "approved" && submission.expiresAt <= Date.now()) {
        return { ...submission, status: "expired" };
      }
      return submission;
    });
}

async function getByReviewTokenHash(reviewTokenHash) {
  const submissions = await readSubmissions();
  const submission = submissions.find((entry) => entry.reviewTokenHash === reviewTokenHash);
  if (submission?.status === "approved" && submission.expiresAt <= Date.now()) {
    return { ...submission, status: "expired" };
  }
  return submission || null;
}

async function getExpiredApprovals(now) {
  const submissions = await readSubmissions();
  return submissions.filter((submission) =>
    submission.status === "approved" &&
    submission.expiresAt <= now &&
    !submission.expiryNotifiedAt
  );
}

module.exports = {
  addSubmission,
  getSubmissions,
  getByReviewTokenHash,
  getExpiredApprovals,
  updateSubmission
};
