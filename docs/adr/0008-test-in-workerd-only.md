# Test in workerd only

The project has one test and typechecking runtime: workerd with Workers types, rather than a fast Node path plus a separate Workers suite. The code deploys in workerd, and the former Node setup had masked Worker-specific typing errors; one runtime makes a passing gate evidence about the program that will run.
