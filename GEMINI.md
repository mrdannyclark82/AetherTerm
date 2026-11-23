# GEMINI - AetherTerm Project

This document provides instructional context for working on the AetherTerm project.

## Project Overview

AetherTerm is a sovereign, web-based terminal and companion interface for the Milla-Rayne / Rayne OS empire. It's a modular application designed for focused planning, coding, integration, testing, and debugging.

The tech stack is:
-   **Frontend:** React, Vite, TypeScript, Tailwind CSS
-   **Backend:** Node.js, Express, Socket.IO
-   **Database:** Firebase Firestore
-   **Authentication:** Firebase Authentication (Google Provider)

The application provides a terminal-like interface, a chat panel for interacting with Milla (powered by local Ollama and Gemini), and a virtual file system.

## Building and Running

### Prerequisites
-   Node.js
-   Ollama (for core Milla responses)

### Local Development
1.  **Install Dependencies:**
    ```bash
    npm install
    ```
2.  **Configure Environment:**
    If required, create a `.env` file and add necessary API keys (e.g., `GEMINI_API_KEY`). See `.env.example`.
3.  **Run the Development Server:**
    ```bash
    npm run dev
    ```
    This starts the Express server with the Vite middleware. The application will be available at the URL shown in the terminal.

### Other Key Commands
-   **Build for Production:**
    ```bash
    npm run build
    ```
-   **Run in Production:**
    ```bash
    npm run start
    ```
-   **Linting:**
    ```bash
    npm run lint
    ```
    This command uses `tsc --noEmit` to check for TypeScript errors.

## Development Conventions & Recommendations

Based on the project's current state, here are some guidelines and recommendations for development:

-   **Modular Architecture:** Continue to build with modularity in mind, ensuring components and services are loosely coupled.
-   **Automated Testing:** The project currently lacks an automated testing framework. It is highly recommended to add unit and integration tests (e.g., using Vitest) to improve code quality and prevent regressions.
-   **Dependency Management:** Regularly review and update dependencies to address security vulnerabilities. Use `npm audit` to identify known issues.
-   **Documentation:** Improve inline code documentation and consider adding more comprehensive documentation for new contributors.
-   **Security:** Enhance security by implementing input validation and refining access controls, especially for real-time and file system operations.
-   **Firebase Rules:** The `firestore.rules` file should be reviewed and updated to ensure data is properly secured.
-   **Git Workflow:** Follow standard Git practices. Create feature branches for new development and use descriptive commit messages.
