#!/bin/bash
set -e
set -u
RELEASE_FROM="develop"
RELEASE_TO="master"
CURRENT_BRANCH="`git branch | grep \* | cut -d ' ' -f2`"
echo "Checking out to '${RELEASE_FROM}' branch and pulling latest"
#git branch --set-upstream-to=origin/develop develop
git checkout ${RELEASE_FROM} 
git pull
echo "Checking out to '${RELEASE_TO}' branch and pulling latest"
git stash save release-production.sh
git checkout ${RELEASE_TO} 
git checkout ${RELEASE_FROM}
git stash pop
git pull origin develop
#read -p "Are you sure you want to merge '${RELEASE_FROM}' into '${RELEASE_TO}'? (y/n)" -n 1 -r
#echo

#if [[ $REPLY =~ ^[Yy]$ ]]
#then
    git merge ${RELEASE_FROM} --ff-only
    git push
#fi

git checkout ${CURRENT_BRANCH}
